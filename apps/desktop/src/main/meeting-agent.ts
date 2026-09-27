import type { ModelGateway } from './model-gateway';

export type MeetingAgentTranscriptLine = {
  id: string;
  speaker: string;
  text: string;
  speakerClusterId?: string;
};

export type MeetingSpeakerIdentity = {
  clusterId: string;
  label: string;
  name: string;
  status: 'unresolved' | 'suggested' | 'confirmed' | 'anonymous';
  confidence?: number;
  reason?: string;
  evidenceLineIds?: string[];
};

export type SpeakerAnalysisResult = {
  speakers: MeetingSpeakerIdentity[];
  question: string;
  warning?: string;
};

export type MeetingMinutesResult = {
  summary: string;
  conclusions: string[];
  actions: Array<{
    title: string;
    owner: string;
    due: string;
    evidenceLineIds: string[];
  }>;
};

type SpeakerAnalysisInput = {
  meetingName: string;
  projectName: string;
  knownPeople: string[];
  transcript: MeetingAgentTranscriptLine[];
  speakers: Array<Pick<MeetingSpeakerIdentity, 'clusterId' | 'label'>>;
};

type RefineSpeakersInput = SpeakerAnalysisInput & {
  identities: MeetingSpeakerIdentity[];
  message: string;
};

type GenerateMinutesInput = {
  meetingName: string;
  projectName: string;
  transcript: MeetingAgentTranscriptLine[];
  speakers: MeetingSpeakerIdentity[];
  confirmations: string[];
};

type StructuredSpeakerSuggestion = {
  clusterId?: unknown;
  label?: unknown;
  suggestedName?: unknown;
  name?: unknown;
  confidence?: unknown;
  reason?: unknown;
  evidenceLineIds?: unknown;
  confirmed?: unknown;
};

const cleanText = (value: unknown, maxLength = 240): string => typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
const uniqueStrings = (value: unknown, maxItems = 20): string[] => Array.isArray(value)
  ? [...new Set(value.map((item) => cleanText(item)).filter(Boolean))].slice(0, maxItems)
  : [];
const confidenceValue = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.min(1, value))
  : undefined;

function transcriptPayload(lines: MeetingAgentTranscriptLine[]): Array<Record<string, string>> {
  return lines
    .filter((line) => line.text.trim())
    .slice(-1_200)
    .map((line) => ({ id: line.id, speaker: line.speaker, text: line.text.slice(0, 800) }));
}

function normalizeSuggestions(
  raw: unknown,
  speakers: Array<Pick<MeetingSpeakerIdentity, 'clusterId' | 'label'>>,
): MeetingSpeakerIdentity[] {
  const object = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const rows = Array.isArray(object.speakers) ? object.speakers as StructuredSpeakerSuggestion[] : [];
  return speakers.map((speaker) => {
    const match = rows.find((row) => cleanText(row.clusterId) === speaker.clusterId || cleanText(row.label) === speaker.label);
    const name = cleanText(match?.suggestedName ?? match?.name, 80);
    const confidence = confidenceValue(match?.confidence);
    return {
      ...speaker,
      name: name || speaker.label,
      status: name && name !== speaker.label ? 'suggested' : 'unresolved',
      ...(confidence !== undefined ? { confidence } : {}),
      ...(cleanText(match?.reason, 320) ? { reason: cleanText(match?.reason, 320) } : {}),
      evidenceLineIds: uniqueStrings(match?.evidenceLineIds, 12),
    };
  });
}

export async function analyzeMeetingSpeakers(gateway: ModelGateway, input: SpeakerAnalysisInput): Promise<SpeakerAnalysisResult> {
  const fallback = normalizeSuggestions({}, input.speakers);
  try {
    const result = await gateway.generateObject<Record<string, unknown>>('fast', [{
      role: 'user',
      content: JSON.stringify({
        meetingName: input.meetingName,
        projectName: input.projectName,
        knownPeople: input.knownPeople,
        speakerClusters: input.speakers,
        transcript: transcriptPayload(input.transcript),
      }),
    }], [
      '你是 KLA 会议智能体，负责从会议转写中分析声纹聚类对应的真实人员。',
      `当前会议仅归属项目“${input.projectName}”；只能使用本次输入提供的项目人员与会议证据，不得读取或推断其他项目的信息。`,
      '只依据明确自我介绍、互相称呼、上下文和已知项目人员给候选；不得虚构姓名。',
      '模型候选永远需要用户确认，不得把推断标为已确认。',
      '返回 JSON：{"speakers":[{"clusterId":"...","label":"说话人1","suggestedName":"姓名或空字符串","confidence":0到1,"reason":"依据","evidenceLineIds":["句子ID"]}],"question":"需要用户确认的问题"}。',
    ].join('\n'));
    const speakers = normalizeSuggestions(result, input.speakers);
    const question = cleanText(result.question, 500) || (speakers.some((speaker) => speaker.status === 'suggested')
      ? '我根据会议中的称呼整理了候选姓名，请逐一确认或修改。'
      : '转写中没有足够信息判断真实姓名，请输入姓名后逐一确认，也可以保留匿名说话人。');
    return { speakers, question };
  } catch (error) {
    return {
      speakers: fallback,
      question: '暂时无法自动判断真实姓名，请输入姓名后逐一确认，也可以保留匿名说话人。',
      warning: error instanceof Error ? error.message : '会议智能体分析失败',
    };
  }
}

function explicitSpeakerNames(message: string, identities: MeetingSpeakerIdentity[]): Map<string, string> {
  const updates = new Map<string, string>();
  const pattern = /说话人\s*(\d+)\s*(?:是|叫|为|：|:)\s*([^，。,；;\n]{1,40})/g;
  for (const match of message.matchAll(pattern)) {
    const label = `说话人${Number(match[1])}`;
    const identity = identities.find((item) => item.label === label);
    const name = match[2]?.trim();
    if (identity && name) updates.set(identity.clusterId, name);
  }
  return updates;
}

export async function refineMeetingSpeakers(gateway: ModelGateway, input: RefineSpeakersInput): Promise<{ speakers: MeetingSpeakerIdentity[]; reply: string; warning?: string }> {
  const explicit = explicitSpeakerNames(input.message, input.identities);
  if (explicit.size > 0) {
    const speakers = input.identities.map((identity) => explicit.has(identity.clusterId)
      ? { ...identity, name: explicit.get(identity.clusterId)!, status: 'confirmed' as const, confidence: 1, reason: '用户在对话中明确确认' }
      : identity);
    const names = speakers.filter((speaker) => explicit.has(speaker.clusterId)).map((speaker) => `${speaker.label}为${speaker.name}`);
    return { speakers, reply: `已确认${names.join('、')}。其余说话人仍需确认。` };
  }

  try {
    const result = await gateway.generateObject<Record<string, unknown>>('fast', [{
      role: 'user',
      content: JSON.stringify({
        meetingName: input.meetingName,
        projectName: input.projectName,
        knownPeople: input.knownPeople,
        currentSpeakers: input.identities,
        userMessage: input.message,
        transcript: transcriptPayload(input.transcript),
      }),
    }], [
      '你是 KLA 会议智能体，结合用户补充修正说话人身份。',
      `当前会议仅归属项目“${input.projectName}”；只能使用本次输入提供的项目人员、转写和用户确认，不得读取或推断其他项目的信息。`,
      '只有用户本条消息明确确认了姓名时 confirmed 才能为 true；推断候选必须为 false。不得虚构姓名。',
      '返回 JSON：{"speakers":[{"clusterId":"...","name":"姓名或候选","confirmed":true或false,"confidence":0到1,"reason":"依据","evidenceLineIds":[]}],"reply":"给用户的简洁回复或追问"}。',
    ].join('\n'));
    const rows = Array.isArray(result.speakers) ? result.speakers as StructuredSpeakerSuggestion[] : [];
    const speakers = input.identities.map((identity) => {
      const match = rows.find((row) => cleanText(row.clusterId) === identity.clusterId || cleanText(row.label) === identity.label);
      const name = cleanText(match?.name ?? match?.suggestedName, 80);
      if (!match || !name) return identity;
      const confidence = confidenceValue(match.confidence);
      return {
        ...identity,
        name,
        status: match.confirmed === true ? 'confirmed' as const : 'suggested' as const,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(cleanText(match.reason, 320) ? { reason: cleanText(match.reason, 320) } : {}),
        evidenceLineIds: uniqueStrings(match.evidenceLineIds, 12),
      };
    });
    return { speakers, reply: cleanText(result.reply, 600) || '我已结合这条补充更新候选，请继续逐一确认。' };
  } catch (error) {
    return {
      speakers: input.identities,
      reply: '这条补充已记录，但我暂时无法完成自动分析。你可以直接输入“说话人1是张三”来确认。',
      warning: error instanceof Error ? error.message : '会议智能体分析失败',
    };
  }
}

export async function generateMeetingMinutes(gateway: ModelGateway, input: GenerateMinutesInput): Promise<MeetingMinutesResult> {
  if (input.speakers.some((speaker) => speaker.status !== 'confirmed' && speaker.status !== 'anonymous')) {
    throw new Error('请先确认全部说话人，再生成会议纪要和待办');
  }
  const result = await gateway.generateObject<Record<string, unknown>>('fast', [{
    role: 'user',
    content: JSON.stringify({
      meetingName: input.meetingName,
      projectName: input.projectName,
      confirmedSpeakers: input.speakers,
      userConfirmations: input.confirmations,
      transcript: transcriptPayload(input.transcript),
    }),
  }], [
    '你是 KLA 会议智能体，在全部说话人身份确认后生成可执行的会议纪要。',
    `当前会议仅归属项目“${input.projectName}”；本次纪要只能依据该项目下的会议转写与用户确认，不得混入其他项目内容。`,
    '只能使用转写和用户确认中的事实，不得补造结论、负责人或日期。负责人或日期未明确时写“待确认”。',
    '返回 JSON：{"summary":"会议摘要","conclusions":["结论"],"actions":[{"title":"待办","owner":"负责人或待确认","due":"日期或待确认","evidenceLineIds":["句子ID"]}]}。',
  ].join('\n'));
  const summary = cleanText(result.summary, 4_000);
  if (!summary) throw new Error('会议智能体未返回有效的会议摘要');
  const conclusions = uniqueStrings(result.conclusions, 30);
  const actions = (Array.isArray(result.actions) ? result.actions : []).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const action = value as Record<string, unknown>;
    const title = cleanText(action.title, 300);
    if (!title) return [];
    return [{
      title,
      owner: cleanText(action.owner, 80) || '待确认',
      due: cleanText(action.due, 80) || '待确认',
      evidenceLineIds: uniqueStrings(action.evidenceLineIds, 12),
    }];
  }).slice(0, 50);
  return { summary, conclusions, actions };
}
