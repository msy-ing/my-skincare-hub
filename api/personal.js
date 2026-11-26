const crypto = require('node:crypto');
module.exports = async function(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const password=process.env.PERSONAL_APP_PASSWORD, token=process.env.NOTION_TOKEN;
  if(!password || password.length<12 || !token) return res.status(503).json({error:'Personal connection not configured'});
  const supplied=req.headers.authorization;
  const origin=req.headers.origin;if(origin&&origin!=='https://'+req.headers.host)return res.status(403).json({error:'Origin not allowed'});
  const hash=s=>crypto.createHash('sha256').update(s).digest();
  const sign=v=>crypto.createHmac('sha256',password).update('personal-session:'+v).digest('hex');
  const equal=(a,b)=>typeof a==='string'&&crypto.timingSafeEqual(hash(a),hash(b));
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-skinSession='))?.split('=')[1]||'';
  const [expiry,nonce,sig]=cookie.split('.');
  const valid=Number(expiry)>Date.now()&&equal(sig,sign(expiry+'.'+nonce));
  if(req.headers['x-personal-logout']==='1'){res.setHeader('Set-Cookie','__Host-skinSession=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');return res.status(200).json({ok:true})}
  if(!valid&&!equal(supplied,'Bearer '+password))return res.status(401).json({error:'Authentication required'});
  const value=(Date.now()+30*86400000)+'.'+crypto.randomBytes(24).toString('hex');
  res.setHeader('Set-Cookie','__Host-skinSession='+value+'.'+sign(value)+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000');
  const ids=['NOTION_ROUTINE_PAGE','NOTION_GUIDE_PAGE','NOTION_INVENTORY_SOURCE'].map(k=>process.env[k]);
  if(ids.some(x=>!x||!/^[a-f0-9-]{32,36}$/i.test(x))) return res.status(503).json({error:'Notion source configuration required'});
  async function read(path,body){
    const r=await fetch('https://api.notion.com/v1/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Notion-Version':'2025-09-03','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
    if(!r.ok) throw Error('Notion request failed');
    return r.json();
  }
  async function all(path,query=false){
    let cursor, results=[];
    do {
      const r=await read(path+(query?'':('?page_size=100'+(cursor?'&start_cursor='+encodeURIComponent(cursor):''))),query?{page_size:100,...(cursor?{start_cursor:cursor}:{})}:undefined);
      results.push(...r.results);
      cursor=r.has_more?r.next_cursor:null;
      if(results.length>2000) throw Error('Source too large');
    }while(cursor);
    return results;
  }
  async function blocks(id,depth=0){
    if(depth>5) throw Error('Source nesting too deep');
    const rows=await all('blocks/'+id+'/children');
    for(const b of rows) if(b.has_children && !['child_page','child_database'].includes(b.type)) b.children=await blocks(b.id,depth+1);
    return rows;
  }
  try {
    const [routine,guide,inventory]=await Promise.all([blocks(ids[0]),blocks(ids[1]),all('data_sources/'+ids[2]+'/query',true)]);
    return res.status(200).json({routine,guide,inventory:inventory.map(p=>({id:p.id,properties:p.properties}))});
  } catch {return res.status(502).json({error:'Unable to read Notion sources'});}
};
