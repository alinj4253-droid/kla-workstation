import { useState } from 'react';
import { PageHead, Card, Tag, Btn, Section, Modal, Alert } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { DIRECTORY } from '../mock';
import type { SanyMemberDto } from '../../../api/sany';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function AdminOrgPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions } = useSanyData();
  const members = data.members;
  const [addOpen, setAddOpen] = useState(false);
  const [dirOpen, setDirOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [removeTarget, setRemoveTarget] = useState<SanyMemberDto | null>(null);

  const joined = members.map(member => member.empNo);
  const available = DIRECTORY.flatMap(dept =>
    dept.members.filter(member => !joined.includes(member.empNo)).map(member => ({ ...member, dept: dept.dept })),
  );
  const admin = members.filter(member => member.role === 'admin');
  const owners = members.filter(member => member.role === 'owner');

  const addByEmpNo = (empNo: string) => {
    const found = available.find(member => member.empNo === empNo);
    if (!found || joined.includes(empNo)) return;
    void actions.addMember({
      empNo: found.empNo,
      name: found.name,
      title: found.title,
      unit: found.dept,
      role: 'owner',
    });
  };

  const doAddMembers = () => {
    picked.forEach(addByEmpNo);
    setPicked([]);
    setAddOpen(false);
  };

  const doRemove = () => {
    if (!removeTarget) return;
    void actions.removeMember(removeTarget.id);
    setRemoveTarget(null);
  };

  return (
    <section className="sany-page">
      <PageHead
        title="组织成员"
        sub="成员从集团组织架构中选取添加。加入后即获得所辖单元的填报与提交权限"
        actions={(
          <>
            <Btn onClick={() => setDirOpen(true)}>查看组织架构</Btn>
            <Btn tone="pri" onClick={() => setAddOpen(true)}>＋ 添加成员</Btn>
          </>
        )}
      />

      <Card className="sany-card--pad sany-card--soft sany-mb20">
        <div className="sany-row sany-gap12">
          <span className="sany-source__ic">人</span>
          <div className="sany-grow">
            <div className="sany-strong">成员来源：集团组织架构（已同步）</div>
            <div className="sany-small sany-mt4">
              直接从事先同步的组织架构中勾选人员加入本规划项目，无需手工录入账号。人员离职或调岗时，组织架构变更会同步提醒。
            </div>
          </div>
          <Tag tone="g" dot>已连接</Tag>
        </div>
      </Card>

      <div className="sany-grid g2 sany-mb20">
        <div>
          <div className="sany-grid g2 sany-mb12">
            <Card className="sany-card--pad">
              <div className="sany-kpi__l">管理员</div>
              <div className="sany-stat__v">{admin.length}</div>
              <div className="sany-kpi__s">拥有全部权限</div>
            </Card>
            <Card className="sany-card--pad">
              <div className="sany-kpi__l">负责人</div>
              <div className="sany-stat__v">{owners.length}</div>
              <div className="sany-kpi__s">从组织架构引入</div>
            </Card>
          </div>
          <Card className="sany-card--pad">
            <div className="sany-strong sany-mb8">权限范围</div>
            <div className="sany-row sany-gap8">
              <Tag tone="b">管理员</Tag>
              <span className="sany-small sany-grow">添加/移除成员 · 派发任务 · 查看全部单元进展 · 收束汇总 · 审阅决策 · 生成成果</span>
            </div>
            <div className="sany-hr" />
            <div className="sany-row sany-gap8">
              <Tag>负责人</Tag>
              <span className="sany-small sany-grow">上传本单元材料 · 校验生成内容 · 管理产出物版本 · 提交交付包 · 不可见其他单元内容</span>
            </div>
          </Card>
        </div>

        <div>
          <div className="sany-sec__h">
            <div className="sany-sec__t">待添加人员</div>
            <div className="sany-sec__s">组织架构中尚未加入本项目的成员</div>
          </div>
          <Card className="sany-card--tight sany-scroll">
            {available.length ? available.map(member => (
              <div className="sany-avail" key={member.empNo}>
                <span className="sany-avail__av">{member.name[0]}</span>
                <div className="sany-grow">
                  <div className="sany-strong">{member.name}</div>
                  <div className="sany-small">{member.dept} · {member.title}</div>
                </div>
                <Btn size="sm" onClick={() => addByEmpNo(member.empNo)}>添加</Btn>
              </div>
            )) : <div className="sany-empty sany-empty--sm">组织架构中的人员已全部加入</div>}
          </Card>
          {available.length ? (
            <Btn block style={{ marginTop: 12 }} onClick={() => setAddOpen(true)}>
              批量选择（{available.length} 人可选）
            </Btn>
          ) : null}
        </div>
      </div>

      <Section title="项目成员" sub={`${members.length} 人`}>
        <div className="sany-tw">
          <table>
            <thead>
              <tr>
                <th style={{ width: '24%' }}>成员</th>
                <th style={{ width: '22%' }}>所属部门</th>
                <th style={{ width: '16%' }}>岗位</th>
                <th style={{ width: 100 }}>角色</th>
                <th style={{ width: 96 }}>工号</th>
                <th style={{ width: 100 }}>加入时间</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {members.map(member => (
                <tr key={member.id}>
                  <td>
                    <div className="sany-row sany-gap8">
                      <span className="sany-member__av" style={{ background: member.color }}>{member.name[0]}</span>
                      <span className="sany-strong">{member.name}</span>
                    </div>
                  </td>
                  <td className="sany-small">{member.unit}</td>
                  <td className="sany-small">{member.title}</td>
                  <td><Tag tone={member.role === 'admin' ? 'b' : ''}>{member.role === 'admin' ? '管理员' : '负责人'}</Tag></td>
                  <td className="sany-small sany-mono">{member.empNo || '—'}</td>
                  <td className="sany-small sany-mono">{member.joined}</td>
                  <td>
                    {member.role === 'admin'
                      ? <span className="sany-small">创建者</span>
                      : <button type="button" className="sany-link" onClick={() => setRemoveTarget(member)}>移除</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="任务绑定" sub="加入组织不等于分配任务，需在派发任务中指定责任单元">
        <div className="sany-tw">
          <table>
            <thead>
              <tr>
                <th style={{ width: 100 }}>负责人</th>
                <th style={{ width: '20%' }}>责任单元</th>
                <th>已派发任务</th>
                <th style={{ width: 96 }}>状态</th>
                <th style={{ width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {members.filter(member => member.role === 'owner').map(member => {
                const req = data.tasks.find(item => item.owner === member.name);
                return (
                  <tr key={member.id}>
                    <td className="sany-small sany-strong">{member.name}</td>
                    <td className="sany-small">{member.unit}</td>
                    <td className="sany-small">{req ? req.title : <span className="sany-muted">未派发</span>}</td>
                    <td>{req ? <Tag tone={req.status === '校验中' ? 'b' : req.status === '分析中' ? 'v' : req.status === '已提交' ? 'g' : ''} dot>{req.status}</Tag> : <Tag>待派发</Tag>}</td>
                    <td>
                      {req
                        ? <button type="button" className="sany-link" onClick={() => onNavigate?.('track')}>查看</button>
                        : <button type="button" className="sany-link" onClick={() => onNavigate?.('assign')}>派发</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Modal
        open={addOpen}
        title="从组织架构添加成员"
        sub="勾选后加入本规划项目"
        onClose={() => setAddOpen(false)}
        wide
        footer={(
          <>
            <Btn onClick={() => setAddOpen(false)}>取消</Btn>
            <Btn tone="pri" onClick={doAddMembers}>添加所选成员</Btn>
          </>
        )}
      >
        <Alert icon="i">人员信息来自集团组织架构，无需手工填写。加入后默认为「负责人」，可获得所辖单元的填报权限。</Alert>
        {DIRECTORY.map(dept => {
          const list = dept.members.filter(member => !joined.includes(member.empNo));
          if (!list.length) return null;
          return (
            <div key={dept.dept} className="sany-mb16">
              <div className="sany-row sany-mb8">
                <b>{dept.dept}</b>
                <Tag>{list.length} 人可选</Tag>
                <span className="sany-spacer" />
                <button
                  type="button"
                  className="sany-link"
                  onClick={() => setPicked(prev => Array.from(new Set([...prev, ...list.map(member => member.empNo)])))}
                >
                  全选
                </button>
              </div>
              {list.map(member => (
                <label className="sany-chkbx" key={member.empNo}>
                  <input
                    type="checkbox"
                    checked={picked.includes(member.empNo)}
                    onChange={event => setPicked(prev =>
                      event.target.checked ? [...prev, member.empNo] : prev.filter(item => item !== member.empNo),
                    )}
                  />
                  <div className="sany-grow">
                    <div className="sany-row sany-gap8">
                      <span className="sany-strong">{member.name}</span>
                      <Tag tone="line">{member.level}</Tag>
                    </div>
                    <div className="sany-small">{member.title} · {member.empNo}</div>
                  </div>
                </label>
              ))}
            </div>
          );
        })}
      </Modal>

      <Modal open={dirOpen} title="集团组织架构" sub="从组织系统同步 · 最后同步 2026-10-21 08:00" onClose={() => setDirOpen(false)} wide
        footer={<Btn tone="pri" onClick={() => setDirOpen(false)}>关闭</Btn>}>
        {DIRECTORY.map(dept => (
          <div key={dept.dept} className="sany-mb16">
            <div className="sany-row sany-mb8">
              <b>{dept.dept}</b>
              <Tag>{dept.members.length} 人</Tag>
            </div>
            {dept.members.map(member => {
              const inProject = joined.includes(member.empNo);
              return (
                <div className="sany-dirrow" key={member.empNo}>
                  <span className="sany-dirrow__n">{member.name}</span>
                  <span className="sany-small sany-grow">{member.title}</span>
                  <span className="sany-small sany-mono sany-dirrow__lv">{member.level}</span>
                  {inProject
                    ? <Tag tone="g">已加入</Tag>
                    : <Btn size="sm" onClick={() => addByEmpNo(member.empNo)}>添加</Btn>}
                </div>
              );
            })}
          </div>
        ))}
      </Modal>

      <Modal
        open={!!removeTarget}
        title="移出项目"
        sub={removeTarget?.name ?? ''}
        onClose={() => setRemoveTarget(null)}
        footer={(
          <>
            <Btn onClick={() => setRemoveTarget(null)}>取消</Btn>
            <Btn tone="pri" onClick={doRemove}>确认移出</Btn>
          </>
        )}
      >
        <Alert tone="w" icon="!">移出后该成员无法再进入本项目。已提交的产出物与材料会保留为历史版本，不会删除。</Alert>
        {(() => {
          const owned = removeTarget ? data.tasks.filter(task => task.owner === removeTarget.name) : [];
          return owned.length ? (
            <div className="sany-mt12">
              <Alert tone="r" icon="!">
                <b>{removeTarget?.name} 当前承接 {owned.length} 项任务：</b>
                {owned.map(task => `${task.unit}（${task.status}）`).join('、')}。
                移出后这些任务将无人负责，在汇总合并中标注为缺报；如需继续推进，请先在派发任务中为对应单元重新指派负责人。
              </Alert>
            </div>
          ) : null;
        })()}
        <div className="sany-note sany-mt12">
          进行中的任务会在移出后需要重新指派负责人，否则将标记为缺报。
        </div>
      </Modal>
    </section>
  );
}
