require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const app = express();
app.disable("x-powered-by");
app.use(express.json({limit:"100kb"}));
app.use(express.static(path.join(__dirname,"public")));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname,"data"));
const ORDERS_FILE = path.join(DATA_DIR,"orders.json");

async function readOrders(){
  try { const parsed=JSON.parse(await fs.readFile(ORDERS_FILE,"utf8")); return Array.isArray(parsed)?parsed:[]; }
  catch(e){ if(e.code==="ENOENT") return []; throw e; }
}
async function saveOrder(order){
  await fs.mkdir(DATA_DIR,{recursive:true});
  const orders=await readOrders(); orders.push(order);
  const temp=ORDERS_FILE+".tmp";
  await fs.writeFile(temp,JSON.stringify(orders,null,2),{mode:0o600});
  await fs.rename(temp,ORDERS_FILE);
}
const clean=(v,n)=>typeof v==="string"?v.trim().slice(0,n):"";
function safkaPath(){
  const p=(process.env.SAFKA_PRODUCTS_PATH||"").trim();
  if(!p.startsWith("/api/v1/public/")) throw Object.assign(new Error("Safka product endpoint is not configured."),{status:503});
  return p;
}
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"VEKRO Store",orderMode:"local-cash-on-delivery",safkaProductsConfigured:Boolean(process.env.SAFKA_API_BASE_URL&&process.env.SAFKA_API_KEY&&process.env.SAFKA_PRODUCTS_PATH)}));
app.get("/api/products",async(_req,res)=>{
  try{
    const base=(process.env.SAFKA_API_BASE_URL||"").trim().replace(/\/$/,"");
    const key=(process.env.SAFKA_API_KEY||"").trim();
    if(!base||!key) throw Object.assign(new Error("لم يتم إعداد اتصال Safka على الخادم بعد."),{status:503});
    const response=await fetch(new URL(safkaPath(),base),{headers:{Accept:"application/json","api-safka-key":key}});
    const raw=await response.text(); let data;
    try{data=raw?JSON.parse(raw):{};}catch{data={};}
    if(!response.ok) throw Object.assign(new Error("Safka request failed ("+response.status+")."),{status:502});
    res.json(data);
  }catch(e){res.status(e.status||502).json({error:e.message});}
});
// Stores COD requests locally; does not submit orders to Safka.
app.post("/api/orders",async(req,res)=>{
  try{
    const c=req.body?.customer||{};
    const name=clean(c.name,100),phone=clean(c.phone,30),address=clean(c.address,500);
    if(name.length<2||! /^[0-9+()\-\s]{7,30}$/.test(phone)||address.length<8)
      return res.status(400).json({error:"يرجى إدخال الاسم ورقم هاتف صحيح والعنوان بالتفصيل."});
    if(!Array.isArray(req.body?.items)||req.body.items.length<1||req.body.items.length>30)
      return res.status(400).json({error:"السلة فارغة أو تحتوي على عدد غير مسموح من المنتجات."});
    const items=req.body.items.map(x=>({product_id:clean(String(x.product_id??x.id??""),100),name:clean(x.name,150),quantity:Math.min(20,Math.max(1,parseInt(x.quantity,10)||1)),displayed_price:Math.max(0,Math.min(10000000,Number(x.price)||0))}));
    if(items.some(x=>!x.name)) return res.status(400).json({error:"يوجد منتج بدون اسم صالح."});
    const order={id:"VK-"+crypto.randomBytes(4).toString("hex").toUpperCase(),created_at:new Date().toISOString(),status:"pending_confirmation",payment_method:"cash_on_delivery",customer:{name,phone,address},items,note:"الأسعار والكميات تحتاج مراجعة المتجر قبل التأكيد."};
    await saveOrder(order);
    res.status(201).json({ok:true,order_id:order.id,status:order.status,message:"تم تسجيل طلبك مبدئيًا، وسيحتاج إلى تأكيد المتجر."});
  }catch(e){console.error("Order save failed:",e.message);res.status(500).json({error:"تعذر حفظ الطلب الآن. حاول مرة أخرى لاحقًا."});}
});
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log("VEKRO Store listening on port "+PORT));
