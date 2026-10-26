import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeAiReview } from './HomeAiReview';
const {list,confirm,current}=vi.hoisted(()=>({list:vi.fn(),confirm:vi.fn(),current:vi.fn()}));
vi.mock('../api/home-ai',()=>({homeAiApi:{list,confirm,current}}));
const session={sessionId:'session',roleName:'审单主管',createdAt:'2026-10-08T01:00:00Z',updatedAt:'2026-10-08T01:00:00Z',revision:3,profileConfirmed:false,answers:{role:'审单主管',mission:'主管复核'},documents:[],candidates:[],scenes:[],nextQuestion:null};
beforeEach(()=>{vi.clearAllMocks();list.mockResolvedValue({ok:true,data:[session]});confirm.mockResolvedValue({ok:true,data:{...session,revision:4,profileConfirmed:true,status:'active'}});current.mockResolvedValue({ok:true,data:{status:'active',sessions:[session],session,bindingVersion:1}});});
describe('human diagnostic review',()=>{
  it('requires a visible human acknowledgement and sends the exact reviewed revision',async()=>{
    const user=userEvent.setup();render(<HomeAiReview conversationId="room" identityId="owner"/>);
    await user.click(screen.getByRole('button',{name:'诊断核对'}));
    const button=await screen.findByRole('button',{name:'确认岗位画像'});expect(button).toBeDisabled();
    expect(screen.getByText('主管复核')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));await user.click(button);
    await waitFor(()=>expect(confirm).toHaveBeenCalledWith('room','owner','session',3,1,'profile',expect.any(String),undefined));
    expect(await screen.findByRole('button',{name:'岗位画像已确认'})).toBeDisabled();
  });
  it('shows conflict guidance and clears old review content',async()=>{
    confirm.mockResolvedValue({ok:false,message:'内容已变化，请刷新诊断'});
    const user=userEvent.setup();render(<HomeAiReview conversationId="room" identityId="owner"/>);
    await user.click(screen.getByRole('button',{name:'诊断核对'}));await screen.findByText('主管复核');
    await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:'确认岗位画像'}));
    expect(await screen.findByText('内容已变化，请刷新诊断')).toBeInTheDocument();
    // 冲突后 refresh 重新拉取绑定，acknowledged 复位
    expect(screen.getByRole('checkbox',{name:/我已核对/})).not.toBeChecked();
  });
});
