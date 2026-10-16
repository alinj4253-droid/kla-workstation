import { useEffect, useState } from 'react';
import type { HomeAiReviewEntry } from '@kla-workstation/contracts';
import { homeAiApi } from '../api/home-ai';

export function useHomeAiReviewEntry(identityId:string,conversationId:string,enabled:boolean,membershipVersion:number,activityVersion:string) {
  const scope=`${identityId}:${conversationId}:${membershipVersion}`;
  const [state,setState]=useState<{scope:string;entry:HomeAiReviewEntry|null;failed:boolean}|null>(null);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!enabled||!identityId||!conversationId)return;
    let live=true;
    void homeAiApi.reviewEntry(conversationId,identityId).then(result=>{
      if(live)setState({scope,entry:result.ok?result.data:null,failed:!result.ok&&result.code!=='FORBIDDEN'&&result.code!=='NOT_FOUND'});
    }).catch(()=>{if(live)setState({scope,entry:null,failed:true});});
    return ()=>{live=false;};
  },[identityId,conversationId,scope,enabled,activityVersion,retry]);
  const current=enabled&&state?.scope===scope?state:null;
  return {entry:current?.entry??null,failed:current?.failed??false,retry:()=>setRetry(value=>value+1)};
}
