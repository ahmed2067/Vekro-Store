require("dotenv").config();
const express=require("express"),path=require("path"),fs=require("fs/promises"),crypto=require("crypto");
const app=express(); app.disable("x-powered-by"); app.use(express.json({limit:"100kb"}));
app.use(express.static(path.join(__dirname,"public")));
const PORT=Number(process.env.PORT||3000),DATA_DIR=path.resolve(process.env.DATA_DIR||path.join(__dirname,"data"));
const ORDERS_FILE=path.join(DATA_DIR,"orders.json"),PRODUCTS_FILE=path.join(DATA_DIR,"local-products.json");
const sessions=new Map(),loginAttempts=new Map();
const statuses=["pending_confirmation","confirmed","processing","shipped","delivered","cancelled"];
const clean=(v,n)=>typeof v==="string"?v.trim().slice(0,n):"";
const safeEqual=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
async function readArray(file){try{const x=JSON.parse(await fs.readFile(file,"utf8"));return Array.isArray(x)?x:[]}catch(e){if(e.code==="ENOENT")return [];throw e}}
async function writeArray(file,arr){await fs.mkdir(DATA_DIR,{recursive:true});const tmp=file+".tmp";await fs.writeFile(tmp,JSON.stringify(arr,null,2),{mode:0o600});await fs.rename(tmp,file)}
async function readOrders(){return readArray(ORDERS_FILE)}
function cookie(req,name){const pair=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));return pair?decodeURIComponent(pair.slice(name.length+1)):""}
function sign(value){return crypto.createHmac("sha256",process.env.SESSION_SECRET||"").update(value).digest("hex")}
function adminAuth(req,res,next){
 const secret=process.env.SESSION_SECRET||"",raw=cookie(req,"vekro_admin"),parts=raw.split(".");
 if(secret.length<32||parts.length!==2||!safeEqual(sign(parts[0]),parts[1]))return res.status(401).json({error:"يلزم تسجيل دخول المدير."});
 const session=sessions.get(parts[0]);if(!session||session.expires<Date.now()){sessions.delete(parts[0]);return res.status(401).json({error:"انتهت الجلسة، سجّل الدخول مجددًا."});}
 next();
}
function rateLimit(req,res,next){
 const key=req.ip||req.socket.remoteAddress||"unknown",now=Date.now(),entry=loginAttempts.get(key)||{count:0,until:now+10*60*1000};
 if(entry.until<now){entry.count=0;entry.until=now+10*60*1000}
 if(entry.count>=8)return res.status(429).json({error:"محاولات كثيرة. انتظر قليلًا ثم حاول."});
 entry.count++;loginAttempts.set(key,entry);next();
}
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"VEKRO Store",orderMode:"local-cash-on-delivery",safkaProductsConfigured:Boolean(process.env.SAFKA_API_BASE_URL&&process.env.SAFKA_API_KEY&&process.env.SAFKA_PRODUCTS_PATH)}));
app.get("/api/products",async(_req,res)=>{
 try{
  const base=(process.env.SAFKA_API_BASE_URL||"").trim().replace(/\/$/,""),key=(process.env.SAFKA_API_KEY||"").trim(),endpoint=(process.env.SAFKA_PRODUCTS_PATH||"").trim();
  if(!base||!key||!endpoint)return res.json(await readArray(PRODUCTS_FILE));
  if(!endpoint.startsWith("/api/v1/public/"))throw new Error("Safka product endpoint must be configured from its public API documentation.");
  const response=await fetch(new URL(endpoint,base),{headers:{Accept:"application/json","api-safka-key":key}});
  const raw=await response.text();let data;try{data=raw?JSON.parse(raw):[]}catch{throw new Error("Safka returned an invalid response.");}
  if(!response.ok)throw new Error("Safka request failed ("+response.status+").");
  res.json(data);
 }catch(e){res.status(502).json({error:e.message})}
});
app.post("/api/orders",async(req,res)=>{
 try{
  const c=req.body?.customer||{},name=clean(c.name,100),phone=clean(c.phone,30),address=clean(c.address,500);
  if(name.length<2||! /^[0-9+()\-\s]{7,30}$/.test(phone)||address.length<8)return res.status(400).json({error:"يرجى إدخال الاسم ورقم هاتف صحيح والعنوان بالتفصيل."});
  if(!Array.isArray(req.body?.items)||req.body.items.length<1||req.body.items.length>30)return res.status(400).json({error:"السلة فارغة أو تحتوي على عدد غير مسموح من المنتجات."});
  const items=req.body.items.map(x=>({product_id:clean(String(x.product_id??x.id??""),100),name:clean(x.name,150),quantity:Math.min(20,Math.max(1,parseInt(x.quantity,10)||1)),displayed_price:Math.max(0,Math.min(10000000,Number(x.price)||0))}));
  if(items.some(x=>!x.name))return res.status(400).json({error:"يوجد منتج بدون اسم صالح."});
  const order={id:"VK-"+crypto.randomBytes(4).toString("hex").toUpperCase(),created_at:new Date().toISOString(),status:"pending_confirmation",payment_method:"cash_on_delivery",customer:{name,phone,address},items};
  const all=await readOrders();all.push(order);await writeArray(ORDERS_FILE,all);
  res.status(201).json({ok:true,order_id:order.id,status:order.status,message:"تم تسجيل طلبك مبدئيًا، وسيحتاج إلى تأكيد المتجر."});
 }catch(e){console.error("Order save failed:",e.message);res.status(500).json({error:"تعذر حفظ الطلب الآن."})}
});
app.post("/api/track",async(req,res)=>{
 const id=clean(req.body?.order_id,30).toUpperCase(),phone=clean(req.body?.phone,30).replace(/\s/g,"");
 if(!id||!phone)return res.status(400).json({error:"أدخل رقم الطلب ورقم الهاتف."});
 const order=(await readOrders()).find(x=>x.id===id&&String(x.customer.phone).replace(/\s/g,"")===phone);
 if(!order)return res.status(404).json({error:"لم نعثر على طلب بهذه البيانات."});
 res.json({order_id:order.id,status:order.status,created_at:order.created_at,payment_method:order.payment_method,items:order.items.map(x=>({name:x.name,quantity:x.quantity}))});
});
app.post("/api/admin/login",rateLimit,(req,res)=>{
 const email=clean(req.body?.email,160).toLowerCase(),password=typeof req.body?.password==="string"?req.body.password:"";
 if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD||!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32)return res.status(503).json({error:"أكمل إعداد بيانات المدير وSESSION_SECRET في إعدادات الاستضافة."});
 if(!safeEqual(email,process.env.ADMIN_EMAIL.toLowerCase())||!safeEqual(password,process.env.ADMIN_PASSWORD))return res.status(401).json({error:"البريد أو كلمة المرور غير صحيحة."});
 const token=crypto.randomBytes(32).toString("hex");sessions.set(token,{expires:Date.now()+8*60*60*1000});
 res.setHeader("Set-Cookie","vekro_admin="+encodeURIComponent(token+"."+sign(token))+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800"+(process.env.NODE_ENV==="production"?"; Secure":""));
 res.json({ok:true});
});
app.post("/api/admin/logout",adminAuth,(req,res)=>{const p=cookie(req,"vekro_admin").split(".");if(p[0])sessions.delete(p[0]);res.setHeader("Set-Cookie","vekro_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+(process.env.NODE_ENV==="production"?"; Secure":""));res.json({ok:true})});
app.get("/api/admin/orders",adminAuth,async(_req,res)=>res.json(await readOrders()));
app.patch("/api/admin/orders/:id",adminAuth,async(req,res)=>{
 const status=clean(req.body?.status,40);if(!statuses.includes(status))return res.status(400).json({error:"حالة الطلب غير صالحة."});
 const all=await readOrders(),i=all.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:"الطلب غير موجود."});
 all[i].status=status;all[i].updated_at=new Date().toISOString();await writeArray(ORDERS_FILE,all);res.json({ok:true,order:all[i]});
});
app.get("/api/admin/products",adminAuth,async(_req,res)=>res.json(await readArray(PRODUCTS_FILE)));
app.post("/api/admin/products",adminAuth,async(req,res)=>{
 const name=clean(req.body?.name,150),price=Number(req.body?.price),category=clean(req.body?.category,80),image=clean(req.body?.image,1000);
 if(name.length<2||!Number.isFinite(price)||price<0||price>10000000)return res.status(400).json({error:"أدخل اسمًا وسعرًا صحيحين."});
 const all=await readArray(PRODUCTS_FILE),product={id:"local-"+crypto.randomBytes(5).toString("hex"),name,price,category:category||"منتجات",image};all.push(product);await writeArray(PRODUCTS_FILE,all);res.status(201).json(product);
});
app.delete("/api/admin/products/:id",adminAuth,async(req,res)=>{const all=await readArray(PRODUCTS_FILE),next=all.filter(x=>x.id!==req.params.id);if(next.length===all.length)return res.status(404).json({error:"المنتج غير موجود في المنتجات المحلية."});await writeArray(PRODUCTS_FILE,next);res.json({ok:true})});
app.get("/admin",(_req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log("VEKRO Store listening on port "+PORT));
