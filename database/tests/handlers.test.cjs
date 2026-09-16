const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../../../supabase-registration/node_modules/typescript');
function load(name, options = {}) {
  const calls = [], messages = [];
  const env = {SUPABASE_URL:'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY:'test-server-key', TELEGRAM_SECRET_TOKEN:'test-webhook', EMAIL_WEBHOOK_SECRET:'test-email', TELEGRAM_BOT_TOKEN:'test-bot', DEFAULT_SUPABASE_USER_ID:'00000000-0000-0000-0000-000000000001', ...options.env};
  const owner = env.DEFAULT_SUPABASE_USER_ID;
  const db = {
    rpc: async (name,args) => { calls.push({rpc:name,args}); return {data:name==='backend_resolve_category'?'category':name==='backend_process_staged_transaction'?{stagingData:{amount:1,description:'safe'},txn:{type:'income'}}:'saved',error:null}; },
    from(table) {
      const call = {table,filters:[],op:'read'}; calls.push(call);
      const query = new Proxy({}, {get(_,method) {
        if (method === 'then') return (resolve) => resolve({data: table==='telegram_users' ? (options.unlinked?null:{supabase_user_id:owner,is_active:true}) : ['insert','upsert'].includes(call.op)?{id:'staged'}:table==='transaction_staging' && options.reply?[{id:'30000000-0000-0000-0000-000000000001'}]:[],error:null});
        return (...args) => {call.filters.push([method,...args]); if(['insert','upsert','update','delete'].includes(method)) call.op=method; return query;};
      }});
      return query;
    }
  };
  let handler;
  const file = path.join(__dirname,'../../functions',name,'index.ts');
  let source = fs.readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'');
  source = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  vm.runInNewContext(source,{Deno:{env:{get:k=>env[k]}},createClient:()=>db,serve:fn=>handler=fn,Response,Request,Date,Map,console:{log(){},error(){}},fetch:async(url,init)=>{messages.push(JSON.parse(init.body));return {json:async()=>({ok:true,result:{message_id:10,chat:{id:101}}})};}});
  return {calls,messages,handler};
}
function request(body, secret='test-webhook', method='POST') {
 return new Request('https://example.invalid',{method,headers:{'x-telegram-bot-api-secret-token':secret,'x-email-webhook-secret':'test-email'},...(method==='POST'?{body:JSON.stringify(body)}:{})});
}
function update(text, extra={}) {return {update_id:42,message:{text,chat:{id:101,type:'private'},from:{id:101},...extra}};}
test('bad webhook authentication or method performs no privileged operation',async()=>{
 const h=load('telegram-webhook'); assert.equal((await h.handler(request(update('/summary'),'wrong'))).status,401); assert.equal((await h.handler(request(null,'test-webhook','GET'))).status,405); assert.equal(h.calls.length,0);
});
test('unlinked sender cannot read reports or write; register cannot link by UUID',async()=>{
 for(const text of ['/summary','outcome 100 Food BCA test','/register 00000000-0000-0000-0000-000000000002']) {
  const h=load('telegram-webhook',{unlinked:true}); await h.handler(request(update(text)));
  assert.ok(h.calls.every(c=>c.table==='telegram_users' && c.op==='read'));
 }
});
test('financial messages in a group are rejected',async()=>{
 const h=load('telegram-webhook');await h.handler(request(update('/summary',{chat:{id:101,type:'group'}}))); assert.ok(h.calls.every(c=>c.table==='telegram_users'));
});
test('summary reads only the mapped user transactions',async()=>{
 const h=load('telegram-webhook');await h.handler(request(update('/summary')));
 const reads=h.calls.filter(c=>c.table==='transactions');assert.ok(reads.length>0);
 for(const read of reads) assert.ok(read.filters.some(f=>f[0]==='eq' && f[1]==='user_id' && f[2]==='00000000-0000-0000-0000-000000000001'));
});
test('bulk confirmation and rejection never fall back to all users',async()=>{
 for(const text of ['/confirm_all','/reject_all']) {
  const h=load('telegram-webhook'); await h.handler(request(update(text)));
  const reads=h.calls.filter(c=>c.table==='transaction_staging');assert.equal(reads.length,1);assert.ok(reads[0].filters.some(f=>f[0]==='eq'&&f[1]==='user_id'));
 }
});
test('direct transaction carries mapped ownership and Telegram update id to atomic RPC',async()=>{
 const h=load('telegram-webhook');await h.handler(request(update('income 100 Salary BCA test')));
 const call=h.calls.find(c=>c.rpc==='backend_save_telegram_transaction'); assert.ok(call);assert.equal(call.args.p_update_id,42);assert.equal(call.args.p_user_id,'00000000-0000-0000-0000-000000000001');
});
test('staging callbacks send verified sender to atomic authorization function',async()=>{
 for(const action of ['confirm','reject']) {
  const h=load('telegram-webhook');await h.handler(request({update_id:43,callback_query:{id:'cb',data:action+':30000000-0000-0000-0000-000000000001',from:{id:202},message:{message_id:1,chat:{id:202,type:'private'}}}}));
  const call=h.calls.find(c=>c.rpc==='backend_process_staged_transaction');assert.equal(call.args.p_telegram_user_id,202);assert.equal(call.args.p_action,action);
 }
});
test('email requires configured owner before category or staging writes',async()=>{
 const h=load('receipt-email-worker',{env:{DEFAULT_SUPABASE_USER_ID:undefined}});
 const res=await h.handler(request({transaction:{amount:100}}));assert.equal(res.status,500);assert.equal(h.calls.length,0);
});
test('email category resolution and staging use same explicit owner',async()=>{
 const h=load('receipt-email-worker');await h.handler(request({transaction:{amount:100,categoryName:'Food'}}));
 const category=h.calls.find(c=>c.rpc==='backend_resolve_category');const staging=h.calls.find(c=>c.table==='transaction_staging'&&c.op==='insert');assert.ok(category && staging);assert.equal(staging.filters.find(f=>f[0]==='insert')[1].user_id,category.args.p_user_id);
});

test('reply confirmations and rejections carry sender mapping',async()=>{
 for(const text of ['confirm','reject']) {
  const h=load('telegram-webhook',{reply:true});await h.handler(request(update(text,{reply_to_message:{message_id:10,chat:{id:101}}})));
  const call=h.calls.find(c=>c.rpc==='backend_process_staged_transaction');assert.ok(call);assert.equal(call.args.p_telegram_user_id,101);
 }
});
test('PDF importer scopes duplicate search and category creation to configured owner',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../scripts/import-jenius-pdf.mjs'),'utf8');
 const section=source.slice(source.indexOf('async function getOrCreateAccount('),source.indexOf('async function sendTelegramConfirmation('));
 const calls=[];
 const owner='00000000-0000-0000-0000-000000000002';
 const context={requireEnv:()=>owner, supabaseRequest:async(p,o)=>{calls.push([p,o]);return p==='rpc/backend_resolve_category'?'category':p.startsWith('transaction_staging?select=id,status')?[]:[{id:'saved'}];}};
 vm.createContext(context);vm.runInContext(section,context);
 await context.insertStaging({categoryName:'Private',accountName:'Jenius',type:'outcome',amount:1,occurred_at:'2026-09-15T00:00:00Z',description:'test'});
 assert.equal(JSON.parse(calls[0][1].body).p_user_id,owner);
 assert.ok(calls.some(([p])=>p.includes('user_id=eq.'+owner)));
 const write=calls.find(([p])=>p==='transaction_staging?select=id');assert.equal(JSON.parse(write[1].body).user_id,owner);
});
