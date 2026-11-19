require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");
  if(req.path==="/admin"||req.path.startsWith("/api/admin/")) res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, private");
  next();
});
app.use(express.json({limit:"100kb"}));
app.use(express.static(path.join(__dirname,"public")));

const PORT = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;
const sessions = new Map();
const loginAttempts = new Map();
const statuses = ["pending_confirmation","confirmed","processing","shipped","delivered","cancelled"];
const clean = (v,n) => typeof v === "string" ? v.trim().slice(0,n) : "";
const safeEqual = (a,b) => {
  const x=Buffer.from(String(a)), y=Buffer.from(String(b));
  return x.length===y.length && crypto.timingSafeEqual(x,y);
};
function requireDb(req,res,next) {
  if(!pool) return res.status(503).json({error:"قاعدة البيانات غير مهيأة على الاستضافة بعد."});
  next();
}
function cookie(req,name) {
  const pair=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));
  return pair ? decodeURIComponent(pair.slice(name.length+1)) : "";
}
function sign(value) {
  return crypto.createHmac("sha256",process.env.SESSION_SECRET||"").update(value).digest("hex");
}
function adminAuth(req,res,next) {
  const secret=process.env.SESSION_SECRET||"", raw=cookie(req,"vekro_admin"), parts=raw.split(".");
  if(secret.length<32||parts.length!==2||!safeEqual(sign(parts[0]),parts[1])) return res.status(401).json({error:"يلزم تسجيل دخول المدير."});
  const session=sessions.get(parts[0]);
  if(!session||session.expires<Date.now()) { sessions.delete(parts[0]); return res.status(401).json({error:"انتهت الجلسة، سجّل الدخول مجددًا."}); }
  next();
}
function rateLimit(req,res,next) {
  const key=req.ip||req.socket.remoteAddress||"unknown", now=Date.now();
  const entry=loginAttempts.get(key)||{count:0,until:now+10*60*1000};
  if(entry.until<now){entry.count=0;entry.until=now+10*60*1000;}
  if(entry.count>=8) return res.status(429).json({error:"محاولات كثيرة. انتظر قليلًا ثم حاول."});
  entry.count++; loginAttempts.set(key,entry); next();
}
app.get("/api/health",async(_req,res)=>{
  if(!pool) return res.status(503).json({ok:false,service:"VEKRO Store",database:"not_configured"});
  try { await pool.query("select 1"); res.json({ok:true,service:"VEKRO Store",database:"connected",orderMode:"cash_on_delivery"}); }
  catch(e){ console.error("Health check failed:",e.message); res.status(503).json({ok:false,service:"VEKRO Store",database:"unavailable"}); }
});

app.get("/api/products",requireDb,async(_req,res)=>{
  try {
    const base=(process.env.SAFKA_API_BASE_URL||"").trim().replace(/\/$/,"");
    const key=(process.env.SAFKA_API_KEY||"").trim();
    const endpoint=(process.env.SAFKA_PRODUCTS_PATH||"").trim();
    if(base&&key&&endpoint){
      if(!endpoint.startsWith("/api/v1/public/")) throw new Error("Safka product endpoint must be configured from its public API documentation.");
      const response=await fetch(new URL(endpoint,base),{headers:{Accept:"application/json","api-safka-key":key}});
      const raw=await response.text(); let data;
      try{data=raw?JSON.parse(raw):[];}catch{throw new Error("Safka returned an invalid response.");}
      if(!response.ok) throw new Error("Safka request failed ("+response.status+").");
      return res.json(data);
    }
    const result=await pool.query("select id,name,price,category,image from public.vekro_products where source='local' order by created_at desc");
    res.json(result.rows);
  } catch(e){res.status(502).json({error:e.message});}
});

app.post("/api/orders",requireDb,(req,res,next)=>{
  const key="order:"+String(req.ip||req.socket.remoteAddress||"unknown"), now=Date.now();
  const entry=loginAttempts.get(key)||{count:0,until:now+15*60*1000};
  if(entry.until<now){entry.count=0;entry.until=now+15*60*1000;}
  if(entry.count>=5) return res.status(429).json({error:"تم تجاوز عدد الطلبات المسموح مؤقتًا. حاول لاحقًا."});
  entry.count++; loginAttempts.set(key,entry); next();
},async(req,res)=>{
  try{
    const c=req.body?.customer||{}, name=clean(c.name,100), phone=clean(c.phone,30), address=clean(c.address,500);
    if(name.length<2||! /^[0-9+()\-\s]{7,30}$/.test(phone)||address.length<8) return res.status(400).json({error:"يرجى إدخال الاسم ورقم هاتف صحيح والعنوان بالتفصيل."});
    if(!Array.isArray(req.body?.items)||req.body.items.length<1||req.body.items.length>30) return res.status(400).json({error:"السلة فارغة أو تحتوي على عدد غير مسموح من المنتجات."});
    const items=req.body.items.map(x=>({product_id:clean(String(x.product_id??x.id??""),100),name:clean(x.name,150),quantity:Math.min(20,Math.max(1,parseInt(x.quantity,10)||1)),displayed_price:Math.max(0,Math.min(10000000,Number(x.price)||0))}));
    if(items.some(x=>!x.name)) return res.status(400).json({error:"يوجد منتج بدون اسم صالح."});
    const id="VK-"+crypto.randomBytes(4).toString("hex").toUpperCase();
    const result=await pool.query(
      "insert into public.vekro_orders (id,status,payment_method,customer,items) values ($1,'pending_confirmation','cash_on_delivery',$2::jsonb,$3::jsonb) returning id,created_at,status",
      [id,JSON.stringify({name,phone,address}),JSON.stringify(items)]
    );
    res.status(201).json({ok:true,order_id:result.rows[0].id,status:result.rows[0].status,message:"تم تسجيل طلبك مبدئيًا، وسيحتاج إلى تأكيد المتجر."});
  }catch(e){console.error("Order save failed:",e.message);res.status(500).json({error:"تعذر حفظ الطلب الآن."});}
});

app.post("/api/track",requireDb,async(req,res)=>{
  try{
    const id=clean(req.body?.order_id,30).toUpperCase(), phone=clean(req.body?.phone,30).replace(/\s/g,"");
    if(!id||!phone) return res.status(400).json({error:"أدخل رقم الطلب ورقم الهاتف."});
    const result=await pool.query("select id,status,created_at,payment_method,customer,items from public.vekro_orders where id=$1 limit 1",[id]);
    const order=result.rows[0];
    if(!order||String(order.customer?.phone||"").replace(/\s/g,"")!==phone) return res.status(404).json({error:"لم نعثر على طلب بهذه البيانات."});
    res.json({order_id:order.id,status:order.status,created_at:order.created_at,payment_method:order.payment_method,items:(order.items||[]).map(x=>({name:x.name,quantity:x.quantity}))});
  }catch(e){console.error("Tracking failed:",e.message);res.status(500).json({error:"تعذر البحث عن الطلب الآن."});}
});

app.post("/api/admin/login",rateLimit,(req,res)=>{
  const email=clean(req.body?.email,160).toLowerCase(), password=typeof req.body?.password==="string"?req.body.password:"";
  if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD||!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32) return res.status(503).json({error:"أكمل إعداد بيانات المدير وSESSION_SECRET في إعدادات الاستضافة."});
  if(!safeEqual(email,process.env.ADMIN_EMAIL.toLowerCase())||!safeEqual(password,process.env.ADMIN_PASSWORD)) return res.status(401).json({error:"البريد أو كلمة المرور غير صحيحة."});
  const token=crypto.randomBytes(32).toString("hex");
  sessions.set(token,{expires:Date.now()+8*60*60*1000});
  res.setHeader("Set-Cookie","vekro_admin="+encodeURIComponent(token+"."+sign(token))+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800"+(process.env.NODE_ENV==="production"?"; Secure":""));
  res.json({ok:true});
});
app.post("/api/admin/logout",adminAuth,(req,res)=>{
  const p=cookie(req,"vekro_admin").split("."); if(p[0]) sessions.delete(p[0]);
  res.setHeader("Set-Cookie","vekro_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+(process.env.NODE_ENV==="production"?"; Secure":""));
  res.json({ok:true});
});
app.get("/api/admin/orders",requireDb,adminAuth,async(_req,res)=>{
  try{const r=await pool.query("select id,created_at,updated_at,status,payment_method,customer,items from public.vekro_orders order by created_at desc");res.json(r.rows);}
  catch(e){console.error(e.message);res.status(500).json({error:"تعذر تحميل الطلبات."});}
});
app.patch("/api/admin/orders/:id",requireDb,adminAuth,async(req,res)=>{
  const status=clean(req.body?.status,40);
  if(!statuses.includes(status)) return res.status(400).json({error:"حالة الطلب غير صالحة."});
  try{
    const r=await pool.query("update public.vekro_orders set status=$1,updated_at=now() where id=$2 returning *",[status,req.params.id]);
    if(!r.rowCount) return res.status(404).json({error:"الطلب غير موجود."});
    res.json({ok:true,order:r.rows[0]});
  }catch(e){console.error(e.message);res.status(500).json({error:"تعذر تحديث حالة الطلب."});}
});
app.get("/api/admin/products",requireDb,adminAuth,async(_req,res)=>{
  try{const r=await pool.query("select id,name,price,category,image,source,created_at from public.vekro_products order by created_at desc");res.json(r.rows);}
  catch(e){console.error(e.message);res.status(500).json({error:"تعذر تحميل المنتجات."});}
});
app.post("/api/admin/products",requireDb,adminAuth,async(req,res)=>{
  const name=clean(req.body?.name,150), price=Number(req.body?.price), category=clean(req.body?.category,80), image=clean(req.body?.image,1000);
  if(name.length<2||!Number.isFinite(price)||price<0||price>10000000) return res.status(400).json({error:"أدخل اسمًا وسعرًا صحيحين."});
  const id="local-"+crypto.randomBytes(5).toString("hex");
  try{
    const r=await pool.query("insert into public.vekro_products (id,name,price,category,image,source) values ($1,$2,$3,$4,$5,'local') returning id,name,price,category,image",[id,name,price,category||"منتجات",image]);
    res.status(201).json(r.rows[0]);
  }catch(e){console.error(e.message);res.status(500).json({error:"تعذر حفظ المنتج."});}
});
app.delete("/api/admin/products/:id",requireDb,adminAuth,async(req,res)=>{
  try{const r=await pool.query("delete from public.vekro_products where id=$1 and source='local' returning id",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"المنتج غير موجود في المنتجات المحلية."});res.json({ok:true});}
  catch(e){console.error(e.message);res.status(500).json({error:"تعذر حذف المنتج."});}
});
app.get("/admin",(_req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const server=app.listen(PORT,()=>console.log("VEKRO Store listening on port "+PORT));
async function shutdown(){server.close(async()=>{if(pool)await pool.end();process.exit(0);});}
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);
