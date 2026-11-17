/** Evaluation-only host adapter. Installed explicitly into a separate DSH profile; never shipped in the plugin. */
export const name='dsh-trivium-eval-bridge';
export const inject=['llm','webServer'];
export async function apply(ctx) {
  const {BlockAssembler,createUserMessage}=await import('@deepseek-ai/dsh-llm');
  let calls=0,running=false;
  ctx.webServer.register({kind:'prefix',path:'/api/trivium-quality-eval',handler:async(req,res)=>{
    const reply=(status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !process.env.TRIVIUM_EVAL_TOKEN
      || req.headers['x-eval-token']!==process.env.TRIVIUM_EVAL_TOKEN || req.headers.origin) return reply(403,{error:'forbidden'});
    try {
      if(req.method==='GET') return reply(200,{provider:'deepseek-account',models:await ctx.llm.listModels('deepseek-account'),calls,limit:48});
      if(req.method!=='POST' || calls>=48 || running) return reply(429,{error:'call limit or busy'});
      let body='';for await(const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>32768)return reply(413,{error:'body limit'});}
      const b=JSON.parse(body);
      if(b.provider!=='deepseek-account'||b.model!=='deepseek-flash'||typeof b.prompt!=='string'||!b.prompt.trim()||b.prompt.length>18000
        || !Number.isSafeInteger(b.maxTokens)||b.maxTokens<1||b.maxTokens>900) return reply(400,{error:'invalid request'});
      running=true;calls++;const started=Date.now(),usage=[],a=new BlockAssembler();
      try {
        for await(const c of ctx.llm.stream({provider:b.provider,model:b.model,maxTokens:b.maxTokens,reasoningEffort:'off',signal:AbortSignal.timeout(120000),
          messages:[createUserMessage({content:[{type:'text',text:b.prompt}],source:{kind:'plugin:dsh-trivium-eval-bridge'}})]})) {a.push(c);if(c.type==='usage')usage.push(c.usage);}
        return reply(200,{text:a.blocks().filter(b=>b.type==='text').map(b=>b.text).join('\n'),finish:a.finish,usage,elapsedMs:Date.now()-started,call:calls,provider:b.provider,model:b.model});
      }finally{running=false;}
    }catch(e){return reply(502,{error:String(e.message).slice(0,500),calls});}
  }});
}
