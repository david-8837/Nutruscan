import { useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { StatusBar, Style as StatusBarStyle } from "@capacitor/status-bar";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { CameraPreview } from "@capacitor-community/camera-preview";
import { LocalNotifications } from "@capacitor/local-notifications";
import { syncMealWaterReminders, scheduleDailyReminderExample } from "./reminders.js";
import { startNativeStepCounter, supportsNativeStepCounter } from "./stepCounter.js";
import { logAppError } from "./monitoring.js";
import { playSfx } from "./sound.js";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";

/* ══════════════ SUPABASE (NutriScan1: piolbedugsubngftsrkm) ══════════════ */
const DEFAULT_SUPA_URL = "https://piolbedugsubngftsrkm.supabase.co";
const DEFAULT_SUPA_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpb2xiZWR1Z3N1Ym5nZnRzcmttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzc2NjcsImV4cCI6MjA4OTYxMzY2N30.Ay3FpuEgT8Ti1rQPWidrLHyjiSwpu2XfBifqKHykkXA";
const resolveSupabaseUrl = (rawUrl) => {
  const candidate = (rawUrl || "").trim();
  if (!candidate) return DEFAULT_SUPA_URL;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return DEFAULT_SUPA_URL;
    }
    return parsed.origin;
  } catch {
    return DEFAULT_SUPA_URL;
  }
};
const SUPA_URL = resolveSupabaseUrl(import.meta.env.VITE_SUPABASE_URL);
/** Prefer .env: VITE_SUPABASE_ANON_KEY=... (Project Settings → API Keys → anon public). */
const SUPA_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPA_ANON_KEY || "").trim();
const OPENROUTER_KEY = (import.meta.env.VITE_OPENROUTER_API_KEY || "").trim();
const OPENROUTER_TEXT_MODEL = "arcee-ai/trinity-large-preview:free";
const WEB3FORMS_ACCESS_KEY = (import.meta.env.VITE_WEB3FORMS_ACCESS_KEY || "").trim();
const WEB3FORMS_ENDPOINT = "https://api.web3forms.com/submit";
const CLOUDINARY_CLOUD_NAME = (import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || "").trim();
const CLOUDINARY_UPLOAD_PRESET = (import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || "nutriscan_profiles").trim();
const FOOD_SEARCH_CACHE = new Map(); // Cache food search results to reduce latency
const FOOD_SEARCH_CACHE_KEY = "nutriscan_food_search_cache_v1";
const FOOD_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const OPENFOOD_FN_URL = `${SUPA_URL}/functions/v1/openfood`;
const PROFILE_IMAGE_BUCKET = "profile-images";
const OAUTH_REDIRECT_URI = "com.nutriscan.app://login-callback";
const SMART_NOTIF_CHANNEL_ID = "nutriscan-smart-alerts";
const SMART_NOTIF_SENT_KEY = "nutriscan_smart_notif_sent";
/** Edge Functions need anon apikey + user JWT (Supabase invoke contract). */
const edgeFnHeaders=(token)=>({"Content-Type":"application/json",apikey:SUPA_KEY,Authorization:`Bearer ${token||""}`});

const isNativeApp=()=>{
  try{return Capacitor.getPlatform()!=="web";}catch{return false;}
};

const isDarkHexColor=(hex)=>{
  const raw=String(hex||"").trim();
  const match=raw.match(/^#([\da-f]{6})$/i);
  if(!match)return true;
  const n=parseInt(match[1],16);
  const r=(n>>16)&255;
  const g=(n>>8)&255;
  const b=n&255;
  const luminance=(0.2126*r+0.7152*g+0.0722*b)/255;
  return luminance<0.55;
};

const AVATAR_COOLDOWN_DAYS=14;
const AVATAR_COOLDOWN_MS=AVATAR_COOLDOWN_DAYS*24*60*60*1000;
const getAvatarRemainingMs=(lastAvatarUpdate)=>{
  if(!lastAvatarUpdate)return 0;
  const lastTs=Date.parse(String(lastAvatarUpdate));
  if(Number.isNaN(lastTs))return 0;
  return Math.max(0,AVATAR_COOLDOWN_MS-(Date.now()-lastTs));
};
const remainingDaysLabel=(remainingMs)=>Math.max(1,Math.ceil(remainingMs/(24*60*60*1000)));
const parseAvatarCooldownDays=(message)=>{
  const m=String(message||"").match(/again in\s+(\d+)\s+day/i);
  return m?Math.max(1,parseInt(m[1],10)||1):null;
};
const extractStorageObjectPath=(publicUrl,bucket)=>{
  try{
    const u=new URL(String(publicUrl||""));
    const marker=`/storage/v1/object/public/${encodeURIComponent(bucket)}/`;
    const idx=u.pathname.indexOf(marker);
    if(idx<0)return null;
    const encoded=u.pathname.slice(idx+marker.length);
    return decodeURIComponent(encoded);
  }catch{return null;}
};

const base64ToBlob=(base64,mime="application/octet-stream")=>{
  const binary=atob(String(base64||""));
  const len=binary.length;
  const bytes=new Uint8Array(len);
  for(let i=0;i<len;i++)bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes],{type:mime});
};

const uploadProfileImageToCloudinary=async(blob,filename)=>{
  if(!CLOUDINARY_CLOUD_NAME){
    throw new Error("Cloudinary not configured. Please set VITE_CLOUDINARY_CLOUD_NAME in .env");
  }
  const formData=new FormData();
  formData.append("file",blob,filename);
  formData.append("upload_preset",CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder","nutriscan/profiles");
  try{
    const response=await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,{
      method:"POST",
      body:formData,
    });
    if(!response.ok){
      const err=await response.json();
      throw new Error(err.error?.message||"Cloudinary upload failed");
    }
    const data=await response.json();
    const secureUrl=String(data?.secure_url||"").trim();
    if(!secureUrl)throw new Error("Cloudinary upload succeeded but secure URL is missing");
    return secureUrl;
  }catch(e){
    throw new Error(`Upload failed: ${e.message}`);
  }
};

const applyNativeStatusBar=async({bgColor,useTransparent,forceStyle})=>{
  if(!isNativeApp())return;
  try{
    if(useTransparent){
      await StatusBar.setOverlaysWebView({overlay:true});
      await StatusBar.setBackgroundColor({color:"#00000000"});
    }else{
      await StatusBar.setOverlaysWebView({overlay:false});
      await StatusBar.setBackgroundColor({color:bgColor||"#0F0F1A"});
    }
    const darkBg=useTransparent?true:isDarkHexColor(bgColor||"#0F0F1A");
    const style=forceStyle||(darkBg?StatusBarStyle.Light:StatusBarStyle.Dark);
    await StatusBar.setStyle({style});
  }catch(e){}
};

const extractSessionFromUrl=(rawUrl)=>{
  const urlText=String(rawUrl||"");
  if(!urlText)return null;
  try{
    const u=new URL(urlText);
    const hash=u.hash?.startsWith("#")?u.hash.slice(1):"";
    const hp=new URLSearchParams(hash);
    const qp=u.searchParams;
    const token=hp.get("access_token")||qp.get("access_token");
    if(!token)return null;
    const refresh=hp.get("refresh_token")||qp.get("refresh_token")||"";
    const userId=hp.get("user_id")||qp.get("user_id")||null;
    return {token,refresh,user_id:userId};
  }catch{return null;}
};

const getOAuthUrl=(provider)=>{
  return `${SUPA_URL}/auth/v1/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(OAUTH_REDIRECT_URI)}`;
};
const startOAuth=async(provider)=>{
  if(typeof window==="undefined")return;
  const oauthUrl=getOAuthUrl(provider);
  if(isNativeApp()){
    try{
      await Browser.open({url:oauthUrl});
      return;
    }catch(e){}
  }
  window.location.href=oauthUrl;
};


const supa = {
  _h(token){
    const h={"Content-Type":"application/json","apikey":SUPA_KEY};
    if(token)h["Authorization"]=`Bearer ${token}`;
    return h;
  },
  async signUp(email,password,meta){
    const r=await fetch(`${SUPA_URL}/auth/v1/signup`,{method:"POST",headers:this._h(),body:JSON.stringify({email,password,data:meta})});
    return r.json();
  },
  async signIn(email,password){
    const r=await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`,{method:"POST",headers:this._h(),body:JSON.stringify({email,password})});
    return r.json();
  },
  async signOut(token){
    await fetch(`${SUPA_URL}/auth/v1/logout`,{method:"POST",headers:this._h(token)});
  },
  async refreshSession(refreshToken){
    const r=await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`,{method:"POST",headers:this._h(),body:JSON.stringify({refresh_token:refreshToken})});
    return r.json();
  },
  async select(token,table,query="*",filter=""){
    const r=await fetch(`${SUPA_URL}/rest/v1/${table}?select=${query}${filter}`,{headers:{...this._h(token),"Prefer":"return=representation"}});
    return r.json();
  },
  async upsert(token,table,data){
    const r=await fetch(`${SUPA_URL}/rest/v1/${table}`,{method:"POST",headers:{...this._h(token),"Prefer":"resolution=merge-duplicates,return=representation"},body:JSON.stringify(data)});
    return r.json();
  },
  async insert(token,table,data){
    const r=await fetch(`${SUPA_URL}/rest/v1/${table}`,{method:"POST",headers:{...this._h(token),"Prefer":"return=representation"},body:JSON.stringify(data)});
    return r.json();
  },
  async del(token,table,filter){
    const r=await fetch(`${SUPA_URL}/rest/v1/${table}?${filter}`,{method:"DELETE",headers:this._h(token)});
    return r.ok;
  },
  async patch(token,table,filter,patch){
    const r=await fetch(`${SUPA_URL}/rest/v1/${table}?${filter}`,{method:"PATCH",headers:{...this._h(token),Prefer:"return=minimal"},body:JSON.stringify(patch)});
    return r.ok;
  },
  async rpc(token,fn,payload={}){
    const r=await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`,{method:"POST",headers:this._h(token),body:JSON.stringify(payload)});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data?.message||data?.error||`${fn} ${r.status}`);
    return data;
  },
  storagePublicUrl(bucket,path){
    return `${SUPA_URL}/storage/v1/object/public/${encodeURIComponent(bucket)}/${String(path||"").split("/").map(encodeURIComponent).join("/")}`;
  },
  async uploadStorageObject(token,bucket,path,blob,contentType="application/octet-stream"){
    const objectPath=String(path||"").split("/").map(encodeURIComponent).join("/");
    const r=await fetch(`${SUPA_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`,{
      method:"POST",
      headers:{apikey:SUPA_KEY,Authorization:`Bearer ${token}`,"x-upsert":"true","Content-Type":contentType},
      body:blob,
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data?.error||data?.message||`storage ${r.status}`);
    return data;
  },
  async removeStorageObject(token,bucket,path){
    const objectPath=String(path||"").split("/").map(encodeURIComponent).join("/");
    const r=await fetch(`${SUPA_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`,{
      method:"DELETE",
      headers:{apikey:SUPA_KEY,Authorization:`Bearer ${token}`},
    });
    if(r.ok||r.status===404)return true;
    const data=await r.json().catch(()=>({}));
    throw new Error(data?.error||data?.message||`storage delete ${r.status}`);
  },
  async getUser(token){
    const r=await fetch(`${SUPA_URL}/auth/v1/user`,{headers:this._h(token)});
    return r.json();
  },
  async countExact(token,table,filter){
    const r=await fetch(`${SUPA_URL}/rest/v1/${table}?select=id${filter}`,{headers:{...this._h(token),Prefer:"count=exact",Range:"0-0"}});
    const cr=r.headers.get("content-range");
    if(!cr)return 0;
    const m=cr.match(/\/(\d+)(?:\s|$)/);
    return m?+m[1]:0;
  },
  /** Call ai-chat Edge Function securely */
  async aiChat(token,messages,system){
    const r=await fetch(`${SUPA_URL}/functions/v1/ai-chat`,{method:"POST",headers:edgeFnHeaders(token),body:JSON.stringify({messages,system})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||`ai-chat ${r.status}`);
    if(data?.error)throw new Error(data.error);
    return data;
  },
  /** Open Food Facts via Edge Function (search | product). */
  async openFood(token,payload){
    const r=await fetch(OPENFOOD_FN_URL,{method:"POST",headers:edgeFnHeaders(token),body:JSON.stringify(payload)});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||`openfood ${r.status}`);
    if(data?.error)throw new Error(data.error);
    return data;
  },
};

const normalizeOpenRouterContent=(content)=>{
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return String(content||"");
  const out=[];
  for(const part of content){
    if(!part||typeof part!=="object")continue;
    if(part.type==="text"&&typeof part.text==="string"){
      out.push({type:"text",text:part.text});
      continue;
    }
    if(part.type==="image_url"&&part.image_url?.url){
      out.push({type:"image_url",image_url:{url:part.image_url.url}});
      continue;
    }
    if(part.type==="image"&&part.source?.type==="base64"&&typeof part.source.data==="string"){
      const mt=typeof part.source.media_type==="string"?part.source.media_type:"image/jpeg";
      out.push({type:"image_url",image_url:{url:`data:${mt};base64,${part.source.data}`}});
    }
  }
  return out.length?out:String(content||"");
};

const messageUsesVision=(msg)=>Array.isArray(msg?.content)&&msg.content.some(p=>p?.type==="image"||p?.type==="image_url");

async function openRouterDirectComplete(messages,system){
  if(!OPENROUTER_KEY)throw new Error("AI is not configured. Missing VITE_OPENROUTER_API_KEY.");
  const raw=[...(system?[{role:"system",content:system}]:[]),...(Array.isArray(messages)?messages:[])];
  const normalized=raw.map(m=>({role:m?.role||"user",content:normalizeOpenRouterContent(m?.content)}));
  const hasVision=normalized.some(messageUsesVision);
  const headers={
    "Authorization":`Bearer ${OPENROUTER_KEY}`,
    "Content-Type":"application/json",
    "HTTP-Referer":typeof window!=="undefined"&&window.location?.origin?window.location.origin:"https://nutriscan.app",
    "X-Title":"NutriScan",
  };
  const tryModel=async(model)=>{
    const r=await fetch("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers,
      body:JSON.stringify({model,messages:normalized,max_tokens:1024}),
    });
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j?.error?.message||j?.message||`OpenRouter ${r.status}`);
    return j?.choices?.[0]?.message?.content||"";
  };
  let text="";
  text=await tryModel(OPENROUTER_TEXT_MODEL);
  return {content:[{text}]};
}

function decodeJwt(token){
  try{
    const parts=String(token||"").split(".");
    if(parts.length!==3)return null;
    const payload=JSON.parse(atob(parts[1]));
    return payload;
  }catch(e){
    return null;
  }
}

function isTokenExpired(token,bufferSecs=60){
  const payload=decodeJwt(token);
  if(!payload?.exp)return false;
  const now=Math.floor(Date.now()/1000);
  return payload.exp<(now+bufferSecs);
}

async function refreshTokenIfNeeded(currentToken){
  const session=loadSession();
  if(!session?.refresh)return currentToken;
  if(!isTokenExpired(currentToken))return currentToken;
  try{
    const refreshed=await supa.refreshSession(session.refresh).catch(()=>null);
    if(refreshed?.access_token){
      const newSession={...session,token:refreshed.access_token,refresh:refreshed.refresh_token||session.refresh,user_id:refreshed.user?.id||session.user_id};
      saveSession(newSession);
      return refreshed.access_token;
    }
  }catch(e){}
  return currentToken;
}

async function aiComplete(token,messages,system){
  try{
    return await openRouterDirectComplete(messages,system);
  }catch(orErr){
    logAppError(orErr,"ai.frontend_openrouter",{ isNative:isNativeApp() });
    throw new Error(orErr?.message||"AI service unavailable");
  }
}

function formatAiErrorMessage(error){
  const raw=String(error?.message||error||"");
  const msg=raw.toLowerCase();
  if(msg.includes("invalid session")||msg.includes("jwt")||msg.includes("401")){
    return "Session expired. Please sign in again.";
  }
  if(msg.includes("openrouter_api_key not set")||msg.includes("server misconfigured")){
    return "AI backend is not configured yet (missing OpenRouter key on server).";
  }
  if(msg.includes("missing vite_openrouter_api_key")||msg.includes("ai is not configured")){
    return "AI is not configured in the app yet. Add VITE_OPENROUTER_API_KEY and rebuild.";
  }
  if(msg.includes("missing authorization")){
    return "Authorization missing. Please sign in again.";
  }
  if(msg.includes("failed to fetch")||msg.includes("network")||msg.includes("load failed")||msg.includes("cors")){
    return "Network error while contacting AI service. Try another network.";
  }
  return raw?`AI error: ${raw}`:"AI service is temporarily unavailable.";
}
const SESSION_KEY="nutriscan_session";
const OFFLINE_QUEUE_KEY="nutriscan_offline_queue";
const saveSession=s=>{try{localStorage.setItem(SESSION_KEY,JSON.stringify(s));}catch(e){}};
const loadSession=()=>{try{return JSON.parse(localStorage.getItem(SESSION_KEY));}catch(e){return null;}};
const clearSession=()=>{try{localStorage.removeItem(SESSION_KEY);}catch(e){}};
const readSentSmartNotifIds=()=>{try{return JSON.parse(localStorage.getItem(SMART_NOTIF_SENT_KEY)||"[]");}catch(e){return[];}};
const writeSentSmartNotifIds=(ids)=>{try{localStorage.setItem(SMART_NOTIF_SENT_KEY,JSON.stringify(ids));}catch(e){}};
const netOnline=()=>typeof navigator!=="undefined"&&navigator.onLine;
const localDayKey=(uid,day,k)=>`nutriscan_local_${uid}_${day}_${k}`;
const saveLocalDay=(uid,day,mealsArr,waterVal)=>{
  try{
    if(!uid||!day)return;
    localStorage.setItem(localDayKey(uid,day,"meals"),JSON.stringify(mealsArr));
    localStorage.setItem(localDayKey(uid,day,"water"),String(waterVal??0));
  }catch(e){}
};
const loadLocalDay=(uid,day)=>{
  try{
    if(!uid||!day)return{meals:null,water:null};
    const m=localStorage.getItem(localDayKey(uid,day,"meals"));
    const w=localStorage.getItem(localDayKey(uid,day,"water"));
    return{meals:m?JSON.parse(m):null,water:w!=null?+w:null};
  }catch(e){return{meals:null,water:null};}
};
const normalizeMealList=(mealsArr=[])=>{
  const seen=new Set();
  const out=[];
  for(const meal of Array.isArray(mealsArr)?mealsArr:[]){
    const key=meal?.id!=null
      ?`id:${meal.id}`
      :`k:${String(meal?.name||"").trim().toLowerCase()}|${Number(meal?.cal||0)}|${Number(meal?.p||0)}|${Number(meal?.c||0)}|${Number(meal?.f||0)}|${String(meal?.m||"").trim().toLowerCase()}|${String(meal?.t||"").trim()}`;
    if(seen.has(key))continue;
    seen.add(key);
    out.push(meal);
  }
  return out;
};
const dayStateEquals=(aMeals,aWater,bMeals,bWater)=>{
  const am=normalizeMealList(aMeals||[]);
  const bm=normalizeMealList(bMeals||[]);
  if(am.length!==bm.length)return false;
  for(let i=0;i<am.length;i++){
    const a=am[i]||{};
    const b=bm[i]||{};
    if(String(a.id||"")!==String(b.id||""))return false;
    if(String(a.name||"")!==String(b.name||""))return false;
    if(Number(a.cal||0)!==Number(b.cal||0))return false;
    if(Number(a.p||0)!==Number(b.p||0))return false;
    if(Number(a.c||0)!==Number(b.c||0))return false;
    if(Number(a.f||0)!==Number(b.f||0))return false;
    if(String(a.e||"")!==String(b.e||""))return false;
    if(String(a.m||"")!==String(b.m||""))return false;
    if(String(a.t||"")!==String(b.t||""))return false;
  }
  return Number(aWater||0)===Number(bWater||0);
};
const sportDayKey=(uid,day)=>`nutriscan_sport_${uid}_${day}`;
const sportStepStateKey=(uid)=>`nutriscan_step_state_${uid}`;
const deriveSportMetrics=(stepsRaw)=>{
  const steps=Math.max(0,Math.round(+stepsRaw||0));
  const distanceKm=Math.round((steps*0.0008)*100)/100;
  const calories=Math.round(steps*0.04);
  const activeMinutes=Math.round(steps/100);
  return{steps,distanceKm,calories,activeMinutes};
};
const readSportDay=(uid,day)=>{
  try{
    if(!uid||!day)return deriveSportMetrics(0);
    const raw=JSON.parse(localStorage.getItem(sportDayKey(uid,day))||"{}");
    return deriveSportMetrics(raw.steps);
  }catch(e){
    return deriveSportMetrics(0);
  }
};
const writeSportDay=(uid,day,steps)=>{
  try{
    if(!uid||!day)return;
    const safeSteps=Math.max(0,Math.round(+steps||0));
    localStorage.setItem(sportDayKey(uid,day),JSON.stringify({steps:safeSteps,updatedAt:new Date().toISOString()}));
  }catch(e){}
};
const readSportStepState=(uid)=>{
  try{
    if(!uid)return{baselineSteps:null,lastSavedDate:null,lastTotalSteps:null};
    const raw=JSON.parse(localStorage.getItem(sportStepStateKey(uid))||"{}");
    const baselineSteps=Number.isFinite(+raw.baselineSteps)?Math.max(0,Math.round(+raw.baselineSteps)):null;
    const lastTotalSteps=Number.isFinite(+raw.lastTotalSteps)?Math.max(0,Math.round(+raw.lastTotalSteps)):null;
    const lastSavedDate=raw.lastSavedDate?String(raw.lastSavedDate):null;
    return{baselineSteps,lastTotalSteps,lastSavedDate};
  }catch(e){
    return{baselineSteps:null,lastSavedDate:null,lastTotalSteps:null};
  }
};
const writeSportStepState=(uid,{baselineSteps,lastTotalSteps,lastSavedDate})=>{
  try{
    if(!uid)return;
    localStorage.setItem(sportStepStateKey(uid),JSON.stringify({
      baselineSteps:Number.isFinite(+baselineSteps)?Math.max(0,Math.round(+baselineSteps)):0,
      lastTotalSteps:Number.isFinite(+lastTotalSteps)?Math.max(0,Math.round(+lastTotalSteps)):0,
      lastSavedDate:lastSavedDate?String(lastSavedDate):ymdLocal(new Date()),
      updatedAt:new Date().toISOString(),
    }));
  }catch(e){}
};
const resolveTodaySportSteps=(uid,day,totalSteps)=>{
  if(!uid||!day)return 0;
  const safeTotal=Math.max(0,Math.round(+totalSteps||0));
  const prev=readSportStepState(uid);
  let baseline=prev.baselineSteps;
  if(!Number.isFinite(+baseline)||prev.lastSavedDate!==day||safeTotal<+baseline){
    baseline=safeTotal;
  }
  const todaySteps=Math.max(0,safeTotal-+baseline);
  writeSportStepState(uid,{baselineSteps:baseline,lastTotalSteps:safeTotal,lastSavedDate:day});
  writeSportDay(uid,day,todaySteps);
  return todaySteps;
};
const readOfflineQueue=()=>{try{return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY)||"[]");}catch(e){return[];}};
const writeOfflineQueue=q=>{try{localStorage.setItem(OFFLINE_QUEUE_KEY,JSON.stringify(q));}catch(e){}};
const enqueueOffline=o=>{const q=readOfflineQueue();q.push(o);writeOfflineQueue(q);};
async function flushOfflineQueue(user,toastFn){
  if(!user?.token||!netOnline())return;
  const queue=readOfflineQueue();
  if(!queue.length)return;
  const checkpointKey=`nutriscan_sync_checkpoint_${user.id}`;
  let synced=0;
  for(let i=0;i<queue.length;i++){
    const op=queue[i];
    try{
      if(op.kind==="meal")await supa.insert(user.token,"meals",op.payload);
      else if(op.kind==="meal-delete")await supa.del(user.token,"meals",`id=eq.${encodeURIComponent(op.payload?.id)}&user_id=eq.${user.id}`);
      else if(op.kind==="water")await supa.upsert(user.token,"water_logs",op.payload);
      else if(op.kind==="settings")await supa.upsert(user.token,"settings",op.payload);
      synced=i+1;
      try{localStorage.setItem(checkpointKey,String(synced));}catch(_e){}
      writeOfflineQueue(queue.slice(i+1));
    }catch(e){
      logAppError(e,"offline_queue_flush_failed");
      writeOfflineQueue(queue.slice(i));
      return;
    }
  }
  writeOfflineQueue([]);
  if(queue.length&&synced===queue.length&&toastFn)toastFn("Offline changes synced","✅");
}


/* ══════════════ TOKENS ══════════════ */
const PROFILE_AVATARS = [
  { idx: 0, name: 'Purple', bg: 'linear-gradient(135deg, #7B6FBF 0%, #9D93D8 100%)', emoji: '👤' },
  { idx: 1, name: 'Mint', bg: 'linear-gradient(135deg, #B8E8D8 0%, #A0D8C8 100%)', emoji: '🧑' },
  { idx: 2, name: 'Pink', bg: 'linear-gradient(135deg, #F9C4CC 0%, #F0A8B3 100%)', emoji: '👩' },
  { idx: 3, name: 'Peach', bg: 'linear-gradient(135deg, #F8DCBC 0%, #F0C8A8 100%)', emoji: '🧔' },
  { idx: 4, name: 'Lavender', bg: 'linear-gradient(135deg, #D0C8F0 0%, #C0B8E0 100%)', emoji: '👨' },
  { idx: 5, name: 'Blue', bg: 'linear-gradient(135deg, #4E8EE0 0%, #3A7AC8 100%)', emoji: '🤵' },
  { idx: 6, name: 'Green', bg: 'linear-gradient(135deg, #3DBF80 0%, #2EA878 100%)', emoji: '🧑‍🌾' },
  { idx: 7, name: 'Orange', bg: 'linear-gradient(135deg, #F09050 0%, #D87840 100%)', emoji: '😊' },
  { idx: 8, name: 'Red', bg: 'linear-gradient(135deg, #E05060 0%, #C84050 100%)', emoji: '💪' },
  { idx: 9, name: 'Navy', bg: 'linear-gradient(135deg, #1C1C2E 0%, #2E2E44 100%)', emoji: '🎯' },
];
const PROFILE_GALLERY_IMAGES = Object.entries(
  import.meta.glob("../Profile Pic/*.{jpg,jpeg,png,webp}", { eager: true, import: "default" })
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => String(url));

/* ══════════════ TOKENS ══════════════ */
const LIGHT = {
  bg:"#ECEEF6", white:"#FFFFFF", navy:"#1C1C2E", purple:"#7B6FBF",
  text:"#1C1C2E", mid:"#5A5A78", light:"#9898B0", border:"#E6E6F0",
  shadow:"rgba(90,90,150,0.10)",
  pink:"#F9C4CC", pinkBg:"#FDE8EC",
  lav:"#D0C8F0",  lavBg:"#EBE7FA",
  mint:"#B8E8D8", mintBg:"#E0F6EE",
  peach:"#F8DCBC",peachBg:"#FEF0E0",
  red:"#E05060", green:"#3DBF80", blue:"#4E8EE0", orange:"#F09050",
};
const DARK = {
  bg:"#0F0F1A", white:"#1C1C2E", navy:"#ECEEF6", purple:"#9D93D8",
  text:"#FFFFFF", mid:"#C0C0D8", light:"#A9A9C4", border:"#2E2E44",
  shadow:"rgba(0,0,0,0.35)",
  pink:"#FF8FA3", pinkBg:"#2A1520",
  lav:"#D0C8F0",  lavBg:"#1E1A38",
  mint:"#6AFCC8", mintBg:"#0E2820",
  peach:"#FFB589",peachBg:"#2A1C0E",
  red:"#FF6B7A", green:"#5DEFTC", blue:"#6CA8FF", orange:"#FFB347",
};
// T is module-level and mutated by App before renders cascade
let T = {...LIGHT};
function buildTheme(darkMode){
  return darkMode ? {...DARK} : {...LIGHT};
}
function buildThemeCSS(t){
  const overlayBg=t.bg==="#0F0F1A"?"rgba(0,0,0,.65)":"rgba(28,28,46,.45)";
  return`:root{--overlay-bg:${overlayBg};--bg:${t.bg};--white:${t.white};--navy:${t.navy};--purple:${t.purple};--text:${t.text};--mid:${t.mid};--light:${t.light};--border:${t.border};--shadow:${t.shadow};--pink:${t.pink};--pinkBg:${t.pinkBg};--lav:${t.lav};--lavBg:${t.lavBg};--mint:${t.mint};--mintBg:${t.mintBg};--peach:${t.peach};--peachBg:${t.peachBg};--red:${t.red};--green:${t.green};--blue:${t.blue};--orange:${t.orange};}html,body,#root{background:${t.bg}!important;color:${t.text}!important;}`;
}

/* ══════════════ CSS ══════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800;900&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html,body{background:var(--bg);font-family:'Nunito',sans-serif;color:var(--text);}
::-webkit-scrollbar{display:none;}
.shell{width:100%;min-height:100vh;background:var(--bg);position:relative;overflow-x:hidden;transition:background .3s,color .3s;}

@keyframes fadeUp  {from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn  {from{opacity:0}to{opacity:1}}
@keyframes float   {0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes scan    {0%{top:8%}100%{top:88%}}
@keyframes blink   {0%,100%{opacity:1}50%{opacity:.4}}
@keyframes popIn   {0%{transform:scale(.82);opacity:0}75%{transform:scale(1.04)}100%{transform:scale(1);opacity:1}}
@keyframes sheetUp {from{transform:translateY(100%)}to{transform:translateY(0)}}
@keyframes toastIn {from{opacity:0;transform:translateX(60px)}to{opacity:1;transform:translateX(0)}}
@keyframes toastOut{from{opacity:1}to{opacity:0;transform:translateX(60px)}}
@keyframes overlayIn{from{opacity:0}to{opacity:1}}
@keyframes shake   {0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
@keyframes spin    {from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes pulse   {0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
@keyframes slideInL{from{opacity:0;transform:translateX(-20px)}to{opacity:1;transform:translateX(0)}}

.aFadeUp {animation:fadeUp .4s ease both;}
.aFadeIn {animation:fadeIn .3s ease both;}
.aPopIn  {animation:popIn .4s cubic-bezier(.34,1.56,.64,1) both;}
.aFloat  {animation:float 3s ease-in-out infinite;}
.aSlideL {animation:slideInL .35s ease both;}
.aSpin   {animation:spin 1s linear infinite;}

/* Cards */
.card {background:var(--white);border-radius:20px;padding:18px;box-shadow:0 4px 20px var(--shadow);transition:background .3s,box-shadow .3s;}
.pcard{border-radius:20px;padding:18px;box-shadow:0 3px 14px var(--shadow);}
.hover-card{transition:transform .18s,box-shadow .18s;cursor:pointer;}
.hover-card:hover{transform:translateY(-3px);box-shadow:0 8px 24px var(--shadow);}
.hover-card:active{transform:translateY(0);}

/* Buttons */
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:15px 20px;border-radius:18px;font-family:'Nunito',sans-serif;font-size:15px;font-weight:800;cursor:pointer;transition:all .18s;letter-spacing:.2px;border:none;}
.btn-primary{background:var(--navy);color:var(--white);}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(28,28,46,.25);}
.btn-primary:active{transform:translateY(0);}
.btn-primary:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none;}
.btn-danger{background:var(--red);color:var(--white);}
.btn-danger:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(224,80,96,.3);}
.btn-ghost{background:var(--white);color:var(--mid);border:2px solid var(--border)!important;}
.btn-ghost:hover{border-color:var(--lav)!important;color:var(--purple);}
.btn-soft{padding:10px 20px;background:var(--lavBg);color:var(--purple);border:none;border-radius:14px;font-family:'Nunito',sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:filter .15s;width:auto;}
.btn-soft:hover{filter:brightness(.96);}
.btn-icon{width:36px;height:36px;border-radius:11px;border:none;background:var(--white);color:var(--mid);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px var(--shadow);transition:all .15s;flex-shrink:0;}
.btn-icon:hover{transform:translateY(-1px);box-shadow:0 4px 12px var(--shadow);}
.btn-social{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px 20px;background:var(--white);border:2px solid var(--border);border-radius:16px;font-family:'Nunito',sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:all .18s;color:var(--text);}
.btn-social:hover{border-color:var(--lav);background:var(--lavBg);}
.check-link{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:700;color:var(--text);cursor:pointer;background:none;border:none;padding:0;font-family:'Nunito',sans-serif;transition:all .15s;}
.check-link:hover{gap:9px;color:var(--purple);}

/* Inputs */
.inp{width:100%;background:var(--bg);border:2px solid transparent;border-radius:14px;padding:13px 16px;font-family:'Nunito',sans-serif;font-size:15px;font-weight:600;color:var(--text);outline:none;transition:all .2s;-webkit-appearance:none;}
.inp:focus{border-color:var(--lav);background:var(--white);}
.inp::placeholder{color:var(--light);font-weight:400;}
.inp.err{border-color:var(--red)!important;background:var(--white);}
.inp-wrap{position:relative;}
.inp-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--light);pointer-events:none;}
.inp-icon-right{position:absolute;right:14px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--light);}
.inp-padl{padding-left:44px!important;}
.inp-padr{padding-right:44px!important;}
select.inp option{background:var(--white);}

/* Form label */
.flabel{font-size:11px;font-weight:700;color:var(--mid);margin-bottom:6px;text-transform:uppercase;letter-spacing:.9px;display:block;}
.ferr{font-size:12px;color:var(--red);font-weight:600;margin-top:4px;}

/* Tab pill */
.tab-pill{padding:8px 18px;border-radius:20px;font-family:'Nunito',sans-serif;font-size:13px;font-weight:700;cursor:pointer;border:none;transition:all .18s;white-space:nowrap;}
.tab-pill.on{background:var(--navy);color:var(--white);}
.tab-pill.off{background:var(--white);color:var(--light);box-shadow:0 2px 8px var(--shadow);}

/* Badge */
.badge{display:inline-flex;align-items:center;gap:3px;padding:4px 11px;border-radius:20px;font-size:12px;font-weight:700;}

/* Macro bar */
.mbar{height:8px;border-radius:4px;background:var(--bg);overflow:hidden;}
.mbar-f{height:100%;border-radius:4px;transition:width 1.1s cubic-bezier(.4,0,.2,1);}

/* Meal row */
.meal-row{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg);border-radius:16px;border:2px solid transparent;cursor:pointer;transition:all .18s;}
.meal-row:hover{background:var(--lavBg);}
.meal-row.selected{background:var(--lavBg);border-color:var(--purple);}

/* Water drop */
.wdrop{width:36px;height:36px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);cursor:pointer;display:flex;align-items:center;justify-content:center;border:2px solid transparent;transition:all .18s;}
.wdrop.on{background:var(--lav);border-color:var(--purple);}
.wdrop.off{background:var(--border);}
.wdrop:hover{transform:rotate(-45deg) scale(1.12);}

/* Toggle */
.toggle{width:48px;height:28px;border-radius:14px;cursor:pointer;position:relative;transition:background .2s;flex-shrink:0;}
.tdot{position:absolute;top:4px;width:20px;height:20px;border-radius:50%;background:var(--white);transition:left .2s;box-shadow:0 1px 4px rgba(0,0,0,.2);}

/* Achievement */
.ach-row{display:flex;align-items:center;gap:14px;padding:14px;border-radius:18px;background:var(--white);box-shadow:0 2px 10px var(--shadow);transition:all .2s;cursor:pointer;}
.ach-row:hover{transform:translateY(-2px);box-shadow:0 6px 16px var(--shadow);}
.ach-row.unlocked{background:var(--lavBg);}

/* Ring */
.ring-stroke{transition:stroke-dashoffset 1.3s cubic-bezier(.4,0,.2,1);}

/* Scan line */
.scan-line{position:absolute;left:5%;right:5%;height:2px;background:linear-gradient(90deg,transparent,var(--purple),transparent);box-shadow:0 0 14px var(--lav);animation:scan 2.2s linear infinite;}

/* Scanner premium UI */
.scan-hero{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding:14px 14px 12px;border-radius:20px;background:linear-gradient(135deg,var(--white),var(--lavBg));border:1px solid var(--border);box-shadow:0 6px 20px var(--shadow);}
.scan-live-pill{display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;background:var(--mintBg);border:1px solid rgba(34,197,94,.2);}
.scan-mode-wrap{display:flex;gap:8px;margin-bottom:16px;overflow-x:auto;padding:6px;background:var(--white);border:1px solid var(--border);border-radius:16px;box-shadow:0 4px 14px var(--shadow);}
.scan-mode-btn{padding:9px 14px;border-radius:12px;font-family:'Nunito',sans-serif;font-size:12px;font-weight:800;cursor:pointer;border:none;transition:all .2s;white-space:nowrap;flex-shrink:0;}
.scan-mode-btn.on{background:var(--navy);color:var(--white);box-shadow:0 6px 14px rgba(28,28,46,.18);}
.scan-mode-btn.off{background:transparent;color:var(--mid);}
.scan-shell{border:1px solid var(--border);box-shadow:0 8px 24px var(--shadow);border-radius:20px;}
.camera-frame{border-radius:16px;overflow:hidden;aspect-ratio:4/3;background:#000;margin-bottom:12px;position:relative;border:1px solid rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);}
.scan-hud{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.72);backdrop-filter:blur(8px);border-radius:20px;padding:6px 16px;display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.12);}
.scan-idle-dark{background:linear-gradient(145deg,#11182A,#1B2136)!important;border:1px solid rgba(255,255,255,.12)!important;box-shadow:0 14px 32px rgba(10,14,26,.35)!important;color:var(--white)!important;}
.scan-idle-sub{color:rgba(255,255,255,.72)!important;}
.scan-idle-icon{font-size:34px;line-height:1;opacity:.9;margin-bottom:10px;display:inline-block;filter:drop-shadow(0 4px 10px rgba(168,85,247,.2));}

/* Bottom nav */
.bnav{position:fixed;bottom:0;left:0;right:0;width:100%;background:var(--white);border-radius:28px 28px 0 0;padding:10px 12px env(safe-area-inset-bottom,16px);display:flex;box-shadow:0 -3px 20px var(--shadow);z-index:200;overflow:hidden;}
.bnav-indicator{position:absolute;left:0;top:0;border-radius:12px;background:var(--navy);pointer-events:none;z-index:0;opacity:0;transition:transform .4s ease-in-out,width .4s ease-in-out,height .4s ease-in-out,opacity .24s ease-in-out;will-change:transform,width,height;}
.bnav-indicator.ready{opacity:1;}
.nb{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;border:none;background:transparent;cursor:pointer;padding:4px 2px;font-family:'Nunito',sans-serif;font-size:10px;font-weight:700;color:var(--light);transition:color .4s ease-in-out;position:relative;z-index:1;}
.nb.active{color:var(--navy);}
.nb-icon{width:50px;height:34px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:transparent;}
.nb-icon svg{transition:stroke .4s ease-in-out;}


/* Overlay / Sheet / Modal */
.overlay{position:fixed;inset:0;background:var(--overlay-bg,rgba(28,28,46,.45));z-index:300;animation:overlayIn .25s ease;display:flex;flex-direction:column;justify-content:flex-end;}
.sheet{background:var(--white);border-radius:28px 28px 0 0;padding:10px 18px 30px;animation:sheetUp .35s cubic-bezier(.34,.18,.64,1);max-height:92vh;overflow-y:auto;width:100%;}
.sheet-handle{width:40px;height:4px;border-radius:2px;background:var(--border);margin:0 auto 18px;}
.modal-bg{position:fixed;inset:0;background:var(--overlay-bg,rgba(28,28,46,.45));z-index:400;animation:overlayIn .25s ease;display:flex;align-items:center;justify-content:center;padding:20px;}
.modal{background:var(--white);border-radius:24px;padding:24px 20px;width:100%;max-width:480px;animation:popIn .35s cubic-bezier(.34,1.2,.64,1);}

/* Toast */
.toast-wrap{position:fixed;top:20px;right:12px;z-index:600;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:240px;}
.toast{background:var(--navy);color:var(--white);border-radius:16px;padding:11px 15px;font-family:'Nunito',sans-serif;font-size:13px;font-weight:700;display:flex;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(28,28,46,.25);animation:toastIn .3s ease;}
.toast.out{animation:toastOut .3s ease forwards;}

/* Auth screens */
.auth-wrap{min-height:100vh;display:flex;flex-direction:column;align-items:stretch;padding:0;background:var(--bg);transition:background .3s,color .3s;}
.auth-logo{font-size:42px;font-weight:900;color:var(--navy);line-height:1;}
.auth-sub{font-size:14px;color:var(--mid);font-weight:600;margin-top:4px;}
.auth-divider{display:flex;align-items:center;gap:12px;margin:20px 0;}
.auth-divider::before,.auth-divider::after{content:'';flex:1;height:1px;background:var(--border);}
.auth-divider span{font-size:12px;font-weight:700;color:var(--light);}
.strength-bar{height:5px;border-radius:3px;transition:all .3s;flex:1;}
.field-group{display:flex;flex-direction:column;gap:14px;margin-bottom:20px;}
.sec-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.sec-title{font-size:16px;font-weight:800;}
.sec-link{font-size:13px;font-weight:700;color:var(--purple);cursor:pointer;background:none;border:none;font-family:'Nunito',sans-serif;padding:0;}
.sec-link:hover{opacity:.7;}
.ob-card{background:var(--white);border-radius:24px;padding:28px 22px;box-shadow:0 8px 30px var(--shadow);}

/* Settings list */
.setting-row{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid var(--border);}
.setting-row:last-child{border-bottom:none;}
.setting-left{display:flex;align-items:center;gap:12px;}
.setting-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;}

/* Profile avatar */
.avatar{border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;color:var(--white);background:linear-gradient(135deg,var(--lav),var(--pink));}

/* Workout log */
.workout-chip{padding:8px 14px;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;border:2px solid transparent;transition:all .18s;font-family:'Nunito';}
.workout-chip.sel{background:var(--lavBg);border-color:var(--purple);color:var(--purple);}
.workout-chip.unsel{background:var(--bg);color:var(--mid);}

/* Pill selector */
.pill-sel{padding:9px 16px;border-radius:20px;font-size:13px;font-weight:700;cursor:pointer;border:2px solid transparent;transition:all .18s;font-family:'Nunito';}
.pill-sel.on{background:var(--navy);color:var(--white);border-color:var(--navy);}
.pill-sel.off{background:var(--white);color:var(--light);border-color:var(--border);}

/* Search */
.search-overlay{position:fixed;inset:0;background:var(--bg);z-index:400;animation:fadeIn .2s ease;overflow-y:auto;}

/* ── Responsive layout ── */
.page-wrap{width:100%;max-width:600px;margin:0 auto;padding:0 16px;}
.content-pad{padding:0 14px;}

@media(max-width:480px){
  .card{border-radius:16px;padding:14px;}
  .pcard{border-radius:16px;padding:14px;}
  .btn{padding:13px 16px;font-size:14px;}
  .auth-logo{font-size:34px;}
  .nb-icon{width:42px;}
  .bnav{padding:8px 8px env(safe-area-inset-bottom,12px);}
}
@media(min-width:481px) and (max-width:768px){
  .page-wrap{max-width:520px;}
}
@media(min-width:769px){
  .page-wrap{max-width:600px;}
  .card{border-radius:22px;}
  .btn{font-size:16px;}
  .nb{font-size:11px;}
  .nb-icon{width:56px;height:38px;}
}
`;

/* ══════════════ DATA ══════════════ */
const INIT_MEALS=[
  {id:1,name:"Masala Oats",cal:280,p:9,c:48,f:6,t:"8:20 AM",e:"🥣",m:"Breakfast"},
  {id:2,name:"Dal Rice + Sabzi",cal:480,p:16,c:78,f:12,t:"1:15 PM",e:"🍛",m:"Lunch"},
  {id:3,name:"Banana & Almonds",cal:180,p:4,c:32,f:6,t:"4:00 PM",e:"🍌",m:"Snack"},
  {id:4,name:"Grilled Paneer",cal:320,p:22,c:8,f:22,t:"8:30 PM",e:"🧀",m:"Dinner"},
];
const INDIAN=[
  {name:"Idli (2 pcs)",cal:120,p:4,c:24,f:1,e:"🍚"},{name:"Dal Tadka",cal:180,p:10,c:28,f:4,e:"🍲"},
  {name:"Roti (1 pc)",cal:100,p:3,c:20,f:1,e:"🫓"},{name:"Chicken Biryani",cal:450,p:18,c:62,f:14,e:"🍛"},
  {name:"Paneer Butter Masala",cal:350,p:18,c:16,f:24,e:"🧀"},{name:"Samosa",cal:140,p:3,c:18,f:7,e:"🔺"},
  {name:"Chole Bhature",cal:520,p:14,c:68,f:22,e:"🫘"},{name:"Upma",cal:190,p:5,c:32,f:6,e:"🥘"},
  {name:"Poha",cal:160,p:4,c:28,f:5,e:"🥣"},{name:"Rajma Chawal",cal:420,p:16,c:70,f:8,e:"🍚"},
  {name:"Aloo Paratha",cal:260,p:6,c:38,f:10,e:"🫓"},{name:"Palak Paneer",cal:290,p:14,c:16,f:18,e:"🥬"},
];
const WORKOUTS=[
  {e:"🏃",name:"Running",cal:320,duration:"30 min",type:"Cardio"},
  {e:"🏋️",name:"Weight Training",cal:280,duration:"45 min",type:"Strength"},
  {e:"🧘",name:"Yoga",cal:150,duration:"40 min",type:"Flexibility"},
  {e:"🚴",name:"Cycling",cal:400,duration:"45 min",type:"Cardio"},
  {e:"🏊",name:"Swimming",cal:360,duration:"30 min",type:"Cardio"},
  {e:"🤸",name:"HIIT",cal:450,duration:"25 min",type:"Cardio"},
];
const RECS=[
  {n:"Greek Salad",c:220,bg:T.mintBg,e:"🥗",p:8,carb:18,f:10},
  {n:"Oat Smoothie",c:180,bg:T.lavBg,e:"🥤",p:6,carb:32,f:4},
  {n:"Grilled Chicken",c:320,bg:T.peachBg,e:"🍗",p:38,carb:0,f:12},
  {n:"Fruit Bowl",c:150,bg:T.pinkBg,e:"🍓",p:2,carb:34,f:1},
  {n:"Boiled Eggs",c:140,bg:T.lavBg,e:"🥚",p:12,carb:0,f:10},
  {n:"Avocado Toast",c:280,bg:T.mintBg,e:"🥑",p:8,carb:28,f:16},
];

/* ══════════════ UTILS ══════════════ */
const fBMR=(g,w,h,a)=>g==="male"?10*w+6.25*h-5*a+5:10*w+6.25*h-5*a-161;
const fTDEE=(bmr,act)=>bmr*({low:1.375,moderate:1.55,high:1.725}[act]||1.55);
const fTarget=(tdee,goal)=>goal==="loss"?Math.round(tdee-500):goal==="gain"?Math.round(tdee+300):Math.round(tdee);
const fBMI=(w,h)=>(w/((h/100)**2)).toFixed(1);
const fBMIlabel=b=>b<18.5?{l:"Underweight",c:T.blue}:b<25?{l:"Normal",c:T.green}:b<30?{l:"Overweight",c:"#F0A840"}:{l:"Obese",c:T.red};
const ymdLocal=d=>{const x=new Date(d);const y=x.getFullYear(),m=String(x.getMonth()+1).padStart(2,"0"),da=String(x.getDate()).padStart(2,"0");return`${y}-${m}-${da}`;};
const addDaysStr=(dateStr,delta)=>{const [y,m,d]=dateStr.split("-").map(Number);const dt=new Date(y,m-1,d);dt.setDate(dt.getDate()+delta);return ymdLocal(dt);};
const dateRangeInclusive=(endStr,nDays)=>{const out=[];for(let i=nDays-1;i>=0;i--)out.push(addDaysStr(endStr,-i));return out;};
const buildRelativeDateOptions=(todayStr,count=5)=>{
  const out=[];
  for(let i=0;i<count;i++){
    const date=addDaysStr(todayStr,-i);
    const label=i===0?"Today":i===1?"Yesterday":`${i} days ago`;
    out.push({offset:i,date,label});
  }
  return out;
};
const formatSelectedDateLabel=(selectedDate,todayStr)=>{
  const sd=String(selectedDate||"").slice(0,10);
  if(!sd)return "Today";
  if(sd===todayStr)return "Today";
  if(sd===addDaysStr(todayStr,-1))return "Yesterday";
  try{return new Date(`${sd}T12:00:00`).toLocaleDateString("en-IN",{day:"numeric",month:"short"});}catch(e){return sd;}
};
const macroTargets=tgt=>({tP:Math.round(tgt*.25/4),tC:Math.round(tgt*.5/4),tF:Math.round(tgt*.25/9)});
function buildAnalyticsInsights({calByDate,proteinByDate,calTarget,streak,onTargetCount,weightMeta,goal}){
  const last7=dateRangeInclusive(ymdLocal(new Date()),7);
  const calVals=last7.map(d=>calByDate.get(d)||0);
  const daysWithData=last7.filter(d=>(calByDate.get(d)||0)>0).length;
  const sum7=calVals.reduce((a,b)=>a+b,0);
  const avg7=daysWithData>0?sum7/daysWithData:0;
  const overDays=last7.filter(d=>(calByDate.get(d)||0)>calTarget*1.08).length;
  const {tP}=macroTargets(calTarget);
  const protVals=last7.map(d=>proteinByDate.get(d)||0);
  const avgP=daysWithData>0?protVals.reduce((a,b)=>a+b,0)/daysWithData:0;
  const out=[];
  if(daysWithData>=3&&avg7>0){
    if(avg7>calTarget*1.08)out.push({e:"📈",txt:`Your recent logged-day average is ~${Math.round(avg7)} kcal — above your ${calTarget} kcal target.`,bg:T.peachBg});
    else if(avg7<calTarget*0.88)out.push({e:"📉",txt:`Your recent logged-day average is ~${Math.round(avg7)} kcal — below your ${calTarget} kcal target.`,bg:T.mintBg});
  }
  if(onTargetCount>=4)out.push({e:"🎯",txt:`${onTargetCount} of the last 7 days landed within ±5% of your calorie target.`,bg:T.lavBg});
  if(streak>=7)out.push({e:"🔥",txt:`${streak}-day logging streak — habits compound.`,bg:T.mintBg});
  else if(streak>=3&&streak<7)out.push({e:"✨",txt:`${streak} days in a row with meals logged.`,bg:T.pinkBg});
  if(weightMeta?.delta!=null&&Math.abs(weightMeta.delta)>0.05)out.push({e:"⚖️",txt:`Weight change vs first log in this window: ${weightMeta.delta>0?"−":"+"}${Math.abs(weightMeta.delta)} kg.`,bg:T.mintBg});
  if(avgP>0&&avgP<tP*0.82)out.push({e:"🥚",txt:`Protein is averaging ~${Math.round(avgP)} g/day — aim for ~${tP} g to match your macro split.`,bg:T.pinkBg});
  if(overDays>=3)out.push({e:"⚠️",txt:`${overDays} days in the last week were well above your calorie target.`,bg:T.peachBg});
  if(goal==="loss"&&avg7>calTarget*1.05&&daysWithData>=3)out.push({e:"💡",txt:"For loss goals, bringing more days near your target helps steady progress.",bg:T.lavBg});
  if(goal==="gain"&&avg7>0&&avg7<calTarget*0.92&&daysWithData>=3)out.push({e:"💡",txt:"For gain goals, try more days at or slightly above your calorie target.",bg:T.lavBg});
  const seen=new Set();
  const uniq=[];
  for(const x of out){
    const k=x.e+x.txt.slice(0,48);
    if(seen.has(k))continue;
    seen.add(k);
    uniq.push(x);
    if(uniq.length>=4)break;
  }
  if(uniq.length===0&&daysWithData===0)return[{e:"📝",txt:"Log meals for a few days to see personalized insights here.",bg:T.bg}];
  if(uniq.length===0)return[{e:"🥗",txt:"Keep logging — your trends will sharpen as data adds up.",bg:T.mintBg}];
  return uniq;
}
function computeMealStreak(mealDatesSet,todayStr){
  let streak=0;
  for(let d=todayStr;;){
    if(!mealDatesSet.has(d))break;
    streak++;
    d=addDaysStr(d,-1);
  }
  return streak;
}
function buildAchievementDefs(){
  return[
    {id:1,e:"🔥",title:"7-Day Streak",desc:"Log meals 7 days in a row",xp:200,bg:"pinkBg"},
    {id:2,e:"🎯",title:"Calorie Champ",desc:"Hit goal 5 days in last 7",xp:150,bg:"lavBg"},
    {id:3,e:"📸",title:"Food Photographer",desc:"Log 20+ meals",xp:100,bg:"mintBg"},
    {id:4,e:"💧",title:"Hydration Hero",desc:"7 days with 8+ glasses",xp:120,bg:"peachBg"},
    {id:5,e:"⚡",title:"Macro Master",desc:"Hit all macros in one day",xp:300,bg:"lavBg"},
    {id:6,e:"🏆",title:"Month Warrior",desc:"30-day logging streak",xp:500,bg:"pinkBg"},
  ];
}
const pwStrength=pw=>{let s=0;if(pw.length>=8)s++;if(/[A-Z]/.test(pw))s++;if(/[0-9]/.test(pw))s++;if(/[^A-Za-z0-9]/.test(pw))s++;return s;};
const pwLabel=s=>["","Weak","Fair","Good","Strong"][s]||"";
const pwColor=s=>[T.border,T.red,T.orange,T.blue,T.green][s]||T.border;
const validateEmail=e=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/* ══════════════ ICONS ══════════════ */
const Ic={
  home:   <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  chart:  <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  camera: <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>,
  trophy: <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="8 21 12 21 16 21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="M7 4H4v5a5 5 0 005 5h6a5 5 0 005-5V4h-3M7 4h10"/></svg>,
  user:   <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  search: <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  bell:   <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>,
  plus:   <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  edit:   <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4z"/></svg>,
  arrowR: <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  arrowL: <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  check:  <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>,
  trend:  <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  trendUp:<svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>,
  x:      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  eye:    <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  eyeOff: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  mail:   <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
  lock:   <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  phone:  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>,
  person: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  shield: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  logout: <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  google: <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M47.5 24.6c0-1.6-.1-3.1-.4-4.6H24.3v8.7h13c-.6 3-2.3 5.5-4.8 7.2v6h7.7c4.5-4.2 7.3-10.3 7.3-17.3z"/><path fill="#34A853" d="M24.3 48c6.5 0 12-2.2 16-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.3 0-11.7-4.3-13.6-10H2.8v6.2C6.7 43.5 15 48 24.3 48z"/><path fill="#FBBC05" d="M10.7 28.5c-.5-1.4-.8-3-.8-4.5s.3-3.1.8-4.5v-6.2H2.8C1 16.6 0 20.2 0 24s1 7.4 2.8 10.7l7.9-6.2z"/><path fill="#EA4335" d="M24.3 9.5c3.5 0 6.7 1.2 9.2 3.6l6.9-6.9C36.3 2.4 30.8 0 24.3 0 15 0 6.7 4.5 2.8 13.3l7.9 6.2c1.9-5.7 7.3-10 13.6-10z"/></svg>,
  apple:  <svg width="17" height="17" viewBox="0 0 24 24" fill={T.text}><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>,
  notification:<svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>,
  moon:   <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>,
  sun:    <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/></svg>,
  wifi:   <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 16 0 016.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>,
  drop:   <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 10 4 14 4 17a8 8 0 0016 0c0-3-2.48-7-8-15z"/></svg>,
  food:   <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>,
  heart:  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>,
  run:    <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><circle cx="12" cy="4" r="2"/><path d="M14.5 8.5L17 7l-2.5 5L12 14l-1 5"/><path d="M9.5 8.5L7 7l1 3"/></svg>,
  export: <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  bg:     <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>,
  trash:  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>,
};

/* ══════════════ TOAST SYSTEM ══════════════ */
let _tid=0;
function useToasts(){
  const [toasts,setToasts]=useState([]);
  const add=useCallback((msg,icon="✅",dur=2800)=>{
    const id=++_tid;
    setToasts(p=>[...p,{id,msg,icon,out:false}]);
    setTimeout(()=>setToasts(p=>p.map(t=>t.id===id?{...t,out:true}:t)),dur-350);
    setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),dur);
  },[]);
  return{toasts,add};
}
function Toasts({toasts}){return <div className="toast-wrap">{toasts.map(t=><div key={t.id} className={`toast${t.out?" out":""}`}><span style={{fontSize:18}}>{t.icon}</span><span>{t.msg}</span></div>)}</div>;}

/* ══════════════ OVERLAY / SHEET / MODAL ══════════════ */
function Overlay({children,onClose}){return <div className="overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>{children}</div>;}
function Sheet({title,onClose,children,right}){
  return <Overlay onClose={onClose}><div className="sheet"><div className="sheet-handle"/>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
      <p style={{fontSize:18,fontWeight:900}}>{title}</p>
      <div style={{display:"flex",gap:10,alignItems:"center"}}>{right}<button onClick={onClose} className="btn-icon" style={{width:32,height:32,borderRadius:10}}>{Ic.x}</button></div>
    </div>{children}</div></Overlay>;
}
function ModalBox({title,onClose,children}){
  return <div className="modal-bg" onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal">
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
      <p style={{fontSize:18,fontWeight:900}}>{title}</p>
      <button onClick={onClose} className="btn-icon" style={{width:32,height:32,borderRadius:10}}>{Ic.x}</button>
    </div>{children}</div></div>;
}

/* ══════════════ STATUS BAR ══════════════ */
const SBar=()=>null;

/* ══════════════ RING ══════════════ */
function Ring({pct,size=130,sw=11,color=T.purple,track=T.lavBg,children}){
  const r=(size-sw)/2,circ=2*Math.PI*r,off=circ*(1-Math.min(pct,1));
  return <div style={{position:"relative",width:size,height:size}}>
    <svg width={size} height={size} style={{transform:"rotate(-90deg)"}}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={track} strokeWidth={sw}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} className="ring-stroke"/>
    </svg>
    <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>{children}</div>
  </div>;
}
const MacroBar=({label,cur,max,color})=><div style={{marginBottom:14}}>
  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontSize:13,fontWeight:600,color:T.mid}}>{label}</span><span style={{fontSize:12,fontWeight:600,color:T.light}}><span style={{color:T.text,fontWeight:700}}>{cur}</span>/{max}g</span></div>
  <div className="mbar"><div className="mbar-f" style={{width:`${Math.min((cur/max)*100,100)}%`,background:color}}/></div>
</div>;
const Toggle=({on,set,color=T.purple})=><div className="toggle" onClick={()=>set&&set(!on)} style={{background:on?color:T.border}}><div className="tdot" style={{left:on?24:4}}/></div>;
const SettingRow=({icon,iconBg,label,sub,right,onClick})=><div className="setting-row" style={{cursor:onClick?"pointer":"default"}} onClick={onClick}
  onMouseEnter={e=>onClick&&(e.currentTarget.style.opacity=".75")} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
  <div className="setting-left"><div className="setting-icon" style={{background:iconBg||T.lavBg}}>{icon}</div><div><p style={{fontSize:14,fontWeight:700}}>{label}</p>{sub&&<p style={{fontSize:11,color:T.light,marginTop:2}}>{sub}</p>}</div></div>
  <div style={{display:"flex",alignItems:"center",gap:8}}>{right}{onClick&&<span style={{color:T.light,fontSize:18}}>›</span>}</div>
</div>;

/* ══════════════ LANDING PAGE ══════════════ */
function Landing({onSignIn,onSignUp}){
  return <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"48px clamp(24px,6vw,80px)",textAlign:"center",position:"relative",overflow:"hidden",background:`linear-gradient(160deg,${T.lav} 0%,${T.bg} 55%,${T.mint} 100%)`}}>
    <div style={{fontSize:84,marginBottom:18}} className="aFloat">🥗</div>
    <h1 style={{fontSize:50,fontWeight:900,color:T.text,lineHeight:1,marginBottom:6}}>NutriScan</h1>
    <p style={{fontSize:13,fontWeight:700,color:T.mid,letterSpacing:2.5,textTransform:"uppercase",marginBottom:8}}>AI · NUTRITION · WELLNESS</p>
    <div style={{width:44,height:4,borderRadius:2,background:T.purple,margin:"10px auto 22px",opacity:.6}}/>
    <p style={{fontSize:15,color:T.light,lineHeight:1.75,maxWidth:270,marginBottom:52,fontWeight:500}}>Track calories with AI. Scan meals instantly. Reach your goals.</p>
    <div style={{width:"100%",maxWidth:300,display:"flex",flexDirection:"column",gap:12}}>
      <button className="btn btn-primary" onClick={onSignUp} style={{borderRadius:20,fontSize:16}}>Create Account — It's Free</button>
      <button className="btn btn-ghost" onClick={onSignIn} style={{borderRadius:20,border:"2px solid "+T.border}}>Sign In to Existing Account</button>
    </div>
    {[{e:"🍎",s:{top:"11%",left:"7%"},d:"0s"},{e:"🥑",s:{top:"18%",right:"5%"},d:"1.2s"},{e:"🍌",s:{bottom:"24%",left:"9%"},d:"2s"},{e:"🫐",s:{bottom:"19%",right:"7%"},d:".6s"}].map((x,i)=>(
      <div key={i} style={{position:"absolute",fontSize:26,opacity:.2,animation:`float 4s ease-in-out infinite ${x.d}`,...x.s}}>{x.e}</div>
    ))}
  </div>;
}

/* ══════════════ SIGN IN ══════════════ */
function SignIn({onSuccess,onSignUp,onForgot}){
  const [form,setForm]=useState({email:"",pw:""});
  const [showPw,setShowPw]=useState(false);
  const [loading,setLoading]=useState(false);
  const [errs,setErrs]=useState({});
  const [shake,setShake]=useState(false);
  const upd=(k,v)=>{setForm(p=>({...p,[k]:v}));setErrs(p=>({...p,[k]:null}));};

  const validate=()=>{
    const e={};
    if(!validateEmail(form.email))e.email="Please enter a valid email";
    if(form.pw.length<4)e.pw="Password is required";
    return e;
  };

  const submit=async()=>{
    const e=validate();
    if(Object.keys(e).length){setErrs(e);setShake(true);setTimeout(()=>setShake(false),500);return;}
    setLoading(true);
    try{
      const data=await supa.signIn(form.email,form.pw);
      if(data.error||!data.access_token){
        setErrs({pw:data.error?.message||"Invalid email or password"});
        setShake(true);setTimeout(()=>setShake(false),500);
        setLoading(false);return;
      }
      saveSession({token:data.access_token,refresh:data.refresh_token,user_id:data.user.id});
      // Load profile
      const profile=await supa.select(data.access_token,"profiles","*",`&id=eq.${data.user.id}`);
      const p=Array.isArray(profile)?profile[0]:null;
      onSuccess({
        token:data.access_token,
        refresh:data.refresh_token,
        id:data.user.id,
        name:p?.name||data.user.email.split("@")[0],
        email:data.user.email,
        profileImageUrl:p?.profile_image_url||"",
        lastAvatarUpdate:p?.last_avatar_update||null,
        age:String(p?.age||28),
        gender:p?.gender||"male",
        height:String(p?.height||170),
        weight:String(p?.weight||70),
        activity:p?.activity||"moderate",
        goal:p?.goal||"loss",
      });
    }catch(err){
      const msg=String(err?.message||"");
      if(/failed to fetch|network|load failed/i.test(msg)){
        setErrs({pw:"Network/DNS issue. Try mobile data or set Private DNS to dns.google, then retry."});
      }else{
        setErrs({pw:msg||"Connection error. Try again."});
      }
    }
    setLoading(false);
  };

  return <div className="auth-wrap">
    <SBar/>
    <div style={{flex:1,paddingTop:16,maxWidth:480,margin:"0 auto",width:"100%",padding:"16px 24px 40px",boxSizing:"border-box"}}>
      <div style={{marginBottom:36}}>
        <div style={{fontSize:36,marginBottom:10}}>👋</div>
        <p className="auth-logo">Welcome back!</p>
        <p className="auth-sub">Sign in to continue your journey</p>
      </div>
      <div className="field-group" style={{animation:shake?"shake .4s ease":undefined}}>
        <div>
          <label className="flabel">Email Address</label>
          <div className="inp-wrap">
            <span className="inp-icon">{Ic.mail}</span>
            <input className={`inp inp-padl${errs.email?" err":""}`} type="email" placeholder="you@example.com" value={form.email} onChange={e=>upd("email",e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/>
          </div>
          {errs.email&&<p className="ferr">{errs.email}</p>}
        </div>
        <div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <label className="flabel" style={{marginBottom:0}}>Password</label>
            <button onClick={onForgot} style={{fontSize:12,fontWeight:700,color:T.purple,background:"none",border:"none",cursor:"pointer",fontFamily:"Nunito"}}>Forgot password?</button>
          </div>
          <div className="inp-wrap">
            <span className="inp-icon">{Ic.lock}</span>
            <input className={`inp inp-padl inp-padr${errs.pw?" err":""}`} type={showPw?"text":"password"} placeholder="Enter password" value={form.pw} onChange={e=>upd("pw",e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/>
            <span className="inp-icon-right" onClick={()=>setShowPw(p=>!p)}>{showPw?Ic.eyeOff:Ic.eye}</span>
          </div>
          {errs.pw&&<p className="ferr">{errs.pw}</p>}
        </div>
      </div>
      <button className="btn btn-primary" onClick={submit} disabled={loading}>
        {loading?<span className="aSpin" style={{display:"inline-block",width:18,height:18,border:"2.5px solid rgba(255,255,255,.4)",borderTop:"2.5px solid white",borderRadius:"50%"}}/>:"Sign In →"}
      </button>
      <div className="auth-divider"><span>or continue with</span></div>
      <div style={{display:"flex",gap:10,marginBottom:28}}>
        <button className="btn-social" onClick={()=>startOAuth("google")} style={{flex:1}}>{Ic.google}Google</button>
        <button className="btn-social" onClick={()=>startOAuth("apple")} style={{flex:1}}>{Ic.apple}Apple</button>
      </div>
      <p style={{textAlign:"center",fontSize:14,color:T.light,fontWeight:600}}>
        Don't have an account?{" "}<span style={{color:T.purple,fontWeight:800,cursor:"pointer"}} onClick={onSignUp}>Sign Up</span>
      </p>
    </div>
  </div>;
}

/* ══════════════ SIGN UP ══════════════ */
function SignUp({onSuccess,onSignIn}){
  const [step,setStep]=useState(0); // 0=account, 1=profile, 2=body, 3=goal
  const [form,setForm]=useState({name:"",email:"",pw:"",confirm:"",phone:"",age:"",gender:"male",height:"",weight:"",activity:"moderate",goal:"loss"});
  const [showPw,setShowPw]=useState(false);
  const [showConfirm,setShowConfirm]=useState(false);
  const [errs,setErrs]=useState({});
  const [loading,setLoading]=useState(false);
  const upd=(k,v)=>{setForm(p=>({...p,[k]:v}));setErrs(p=>({...p,[k]:null}));};

  const pw=form.pw;
  const str=pwStrength(pw);

  const validate0=()=>{const e={};if(!form.name.trim())e.name="Name is required";if(!validateEmail(form.email))e.email="Invalid email";if(pw.length<8)e.pw="Min 8 characters";if(pw!==form.confirm)e.confirm="Passwords do not match";return e;};
  const validate1=()=>{const e={};if(!form.age||+form.age<10||+form.age>100)e.age="Enter valid age";return e;};
  const validate2=()=>{const e={};if(!form.height||+form.height<100)e.height="Enter valid height";if(!form.weight||+form.weight<30)e.weight="Enter valid weight";return e;};

  const [signupDone,setSignupDone]=useState(false); // show "check email" screen

  const next=async()=>{
    let e={};
    if(step===0)e=validate0();
    if(step===1)e=validate1();
    if(step===2)e=validate2();
    if(Object.keys(e).length){setErrs(e);return;}
    if(step<3){setStep(s=>s+1);return;}
    setLoading(true);

    setErrs(e=>({...e,submit:null}));
    try{
      const email=form.email.trim();
      const meta={
        name:form.name.trim(),
        age:form.age,
        gender:form.gender,
        height:form.height,
        weight:form.weight,
        activity:form.activity,
        goal:form.goal,
      };
      const data=await supa.signUp(email,form.pw,meta);
      const errMsg=data.error_description||data.msg||data.message||(typeof data.error==="string"?data.error:data.error?.message);
      if(errMsg||data.error_code){
        setErrs({submit:errMsg||"Sign up failed. Try again or sign in if you already have an account."});
        setLoading(false);
        return;
      }
      if(data.access_token&&data.user?.id){
        const uid=data.user.id;
        const tok=data.access_token;
        saveSession({token:tok,refresh:data.refresh_token,user_id:uid});
        const profilePayload={
          id:uid,
          email,
          name:form.name.trim(),
          age:+form.age||28,
          gender:form.gender,
          height:+form.height||170,
          weight:+form.weight||70,
          activity:form.activity,
          goal:form.goal,
          onboarding_completed:true,
        };
        try{await supa.upsert(tok,"profiles",profilePayload);}catch(e){}
        setLoading(false);
        onSuccess({
          token:tok,
          refresh:data.refresh_token,
          id:uid,
          name:form.name.trim(),
          email,
          profileImageUrl:"",
          lastAvatarUpdate:null,
          age:String(form.age),
          gender:form.gender,
          height:String(form.height),
          weight:String(form.weight),
          activity:form.activity,
          goal:form.goal,
        });
        return;
      }
      if(data.user?.id&&!data.access_token){
        setLoading(false);
        setSignupDone(true);
        return;
      }
      setErrs({submit:"Could not complete sign up. Try again or use Sign In."});
      setLoading(false);
    }catch(err){
      const message = String(err?.message || "");
      if (/invalid\s*url/i.test(message)) {
        setErrs({submit:"App configuration issue detected. Please reinstall the latest build and try again."});
      } else if (/failed to fetch|network|load failed/i.test(message)) {
        setErrs({submit:"Network/DNS issue. Try mobile data or set Private DNS to dns.google, then retry."});
      } else {
        setErrs({submit:message||"Connection error. Check your internet and try again."});
      }
      setLoading(false);
    }
  };

  const STEPS=[
    // STEP 0 — Account
    <div key={0} className="aFadeIn" style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label className="flabel">Full Name</label><div className="inp-wrap"><span className="inp-icon">{Ic.person}</span><input className={`inp inp-padl${errs.name?" err":""}`} placeholder="Jane Doe" value={form.name} onChange={e=>upd("name",e.target.value)}/></div>{errs.name&&<p className="ferr">{errs.name}</p>}</div>
      <div><label className="flabel">Email Address</label><div className="inp-wrap"><span className="inp-icon">{Ic.mail}</span><input className={`inp inp-padl${errs.email?" err":""}`} type="email" placeholder="you@example.com" value={form.email} onChange={e=>upd("email",e.target.value)}/></div>{errs.email&&<p className="ferr">{errs.email}</p>}</div>
      <div><label className="flabel">Phone (optional)</label><div className="inp-wrap"><span className="inp-icon">{Ic.phone}</span><input className={`inp inp-padl`} type="tel" placeholder="+91 98765 43210" value={form.phone} onChange={e=>upd("phone",e.target.value)}/></div></div>
      <div>
        <label className="flabel">Password</label>
        <div className="inp-wrap"><span className="inp-icon">{Ic.lock}</span><input className={`inp inp-padl inp-padr${errs.pw?" err":""}`} type={showPw?"text":"password"} placeholder="Min 8 characters" value={pw} onChange={e=>upd("pw",e.target.value)}/><span className="inp-icon-right" onClick={()=>setShowPw(p=>!p)}>{showPw?Ic.eyeOff:Ic.eye}</span></div>
        {pw&&<div style={{marginTop:8}}><div style={{display:"flex",gap:4,marginBottom:4}}>{[1,2,3,4].map(i=><div key={i} className="strength-bar" style={{background:i<=str?pwColor(str):T.border}}/>)}</div><p style={{fontSize:11,fontWeight:700,color:pwColor(str)}}>{pwLabel(str)}</p></div>}
        {errs.pw&&<p className="ferr">{errs.pw}</p>}
      </div>
      <div><label className="flabel">Confirm Password</label><div className="inp-wrap"><span className="inp-icon">{Ic.lock}</span><input className={`inp inp-padl inp-padr${errs.confirm?" err":""}`} type={showConfirm?"text":"password"} placeholder="Repeat password" value={form.confirm} onChange={e=>upd("confirm",e.target.value)}/><span className="inp-icon-right" onClick={()=>setShowConfirm(p=>!p)}>{showConfirm?Ic.eyeOff:Ic.eye}</span></div>{errs.confirm&&<p className="ferr">{errs.confirm}</p>}</div>
    </div>,
    // STEP 1 — Age & Gender
    <div key={1} className="ob-card aFadeIn">
      <div style={{fontSize:48,textAlign:"center",marginBottom:14}}>📅</div>
      <h3 style={{fontSize:22,fontWeight:900,textAlign:"center",marginBottom:4}}>Your Profile</h3>
      <p style={{fontSize:13,color:T.light,textAlign:"center",marginBottom:24}}>We'll personalize your experience</p>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label className="flabel">Age</label><input className={`inp${errs.age?" err":""}`} type="number" placeholder="25" value={form.age} onChange={e=>upd("age",e.target.value)}/>{errs.age&&<p className="ferr">{errs.age}</p>}</div>
        <div><label className="flabel">Gender</label>
          <div style={{display:"flex",gap:10}}>{[{v:"male",l:"👨 Male"},{v:"female",l:"👩 Female"},{v:"other",l:"⚧ Other"}].map(g=>(
            <div key={g.v} onClick={()=>upd("gender",g.v)} style={{flex:1,padding:"11px 6px",borderRadius:14,textAlign:"center",cursor:"pointer",background:form.gender===g.v?T.lavBg:T.bg,border:`2px solid ${form.gender===g.v?T.purple:"transparent"}`,fontWeight:700,fontSize:13,color:form.gender===g.v?T.purple:T.mid,transition:"all .18s"}}>{g.l}</div>
          ))}</div>
        </div>
      </div>
    </div>,
    // STEP 2 — Body Stats
    <div key={2} className="ob-card aFadeIn">
      <div style={{fontSize:48,textAlign:"center",marginBottom:14}}>📏</div>
      <h3 style={{fontSize:22,fontWeight:900,textAlign:"center",marginBottom:4}}>Body Stats</h3>
      <p style={{fontSize:13,color:T.light,textAlign:"center",marginBottom:24}}>Used to calculate your calorie needs</p>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label className="flabel">Height (cm)</label><input className={`inp${errs.height?" err":""}`} type="number" placeholder="170" value={form.height} onChange={e=>upd("height",e.target.value)}/>{errs.height&&<p className="ferr">{errs.height}</p>}</div>
        <div><label className="flabel">Weight (kg)</label><input className={`inp${errs.weight?" err":""}`} type="number" placeholder="70" value={form.weight} onChange={e=>upd("weight",e.target.value)}/>{errs.weight&&<p className="ferr">{errs.weight}</p>}</div>
        <div><label className="flabel">Activity Level</label>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {[{v:"low",l:"🛋️ Sedentary"},{v:"moderate",l:"🚶 Moderately Active"},{v:"high",l:"🏃 Very Active"}].map(o=>(
              <div key={o.v} onClick={()=>upd("activity",o.v)} style={{padding:"12px 16px",borderRadius:14,cursor:"pointer",background:form.activity===o.v?T.lavBg:T.bg,border:`2px solid ${form.activity===o.v?T.purple:"transparent"}`,fontWeight:700,fontSize:14,color:form.activity===o.v?T.purple:T.mid,transition:"all .18s",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                {o.l}{form.activity===o.v&&<div style={{color:T.purple}}>{Ic.check}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    // STEP 3 — Goal
    <div key={3} className="ob-card aFadeIn">
      <div style={{fontSize:48,textAlign:"center",marginBottom:14}}>🎯</div>
      <h3 style={{fontSize:22,fontWeight:900,textAlign:"center",marginBottom:4}}>Your Goal</h3>
      <p style={{fontSize:13,color:T.light,textAlign:"center",marginBottom:24}}>We'll set the right calorie target</p>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {[{v:"loss",l:"Lose Weight",d:"−500 kcal/day deficit",i:"📉",bg:T.pinkBg},{v:"maintain",l:"Maintain Weight",d:"Stay at current weight",i:"⚖️",bg:T.lavBg},{v:"gain",l:"Gain Muscle",d:"+300 kcal/day surplus",i:"📈",bg:T.mintBg}].map(o=>(
          <div key={o.v} onClick={()=>upd("goal",o.v)} style={{padding:"16px",borderRadius:18,cursor:"pointer",background:form.goal===o.v?o.bg:T.bg,border:`2px solid ${form.goal===o.v?T.purple:"transparent"}`,display:"flex",alignItems:"center",gap:14,transition:"all .18s"}}>
            <div style={{width:48,height:48,borderRadius:14,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,boxShadow:`0 2px 8px ${T.shadow}`}}>{o.i}</div>
            <div style={{flex:1}}><p style={{fontWeight:800,fontSize:14,color:form.goal===o.v?T.purple:T.text}}>{o.l}</p><p style={{fontSize:12,color:T.light,marginTop:2}}>{o.d}</p></div>
            {form.goal===o.v&&<div style={{color:T.purple}}>{Ic.check}</div>}
          </div>
        ))}
      </div>
    </div>,
  ];

  if(signupDone) return <div className="auth-wrap">
    <SBar/>
    <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 24px",textAlign:"center"}}>
      <div style={{fontSize:72,marginBottom:20}}>📧</div>
      <p style={{fontSize:26,fontWeight:900,marginBottom:8}}>Check Your Email!</p>
      <p style={{fontSize:15,color:T.mid,lineHeight:1.7,marginBottom:10}}>We sent a confirmation link to</p>
      <p style={{fontSize:16,fontWeight:800,color:T.purple,marginBottom:28}}>{form.email}</p>
      <p style={{fontSize:13,color:T.light,lineHeight:1.6,marginBottom:32}}>Click the link in the email to confirm your account, then come back and sign in.</p>
      <button className="btn btn-primary" style={{maxWidth:280,width:"100%"}} onClick={onSignIn}>Go to Sign In</button>
      <p style={{fontSize:12,color:T.light,marginTop:16}}>Didn't get it? Check your spam folder.</p>
    </div>
  </div>;

  return <div className="auth-wrap">
    <SBar/>
    <div style={{flex:1,paddingTop:16,maxWidth:480,margin:"0 auto",width:"100%",padding:"16px 24px 40px",boxSizing:"border-box"}}>
      <div style={{marginBottom:24}}>
        {step===0?<><div style={{fontSize:32,marginBottom:8}}>✨</div><p className="auth-logo">Create Account</p><p className="auth-sub">Start your wellness journey today</p></>
          :<div style={{display:"flex",gap:6,marginBottom:20}}>
            {[0,1,2,3].map(i=><div key={i} style={{height:5,borderRadius:3,flex:i===step?3:1,background:i<=step?T.purple:T.border,transition:"all .3s"}}/>)}
          </div>}
      </div>
      {STEPS[step]}
      <div style={{display:"flex",gap:12,marginTop:24}}>
        {step>0&&<button className="btn btn-ghost" onClick={()=>setStep(s=>s-1)} style={{flex:1,border:"2px solid "+T.border}}>← Back</button>}
        <button className="btn btn-primary" onClick={next} disabled={loading} style={{flex:step>0?2:1}}>
          {loading?<span className="aSpin" style={{display:"inline-block",width:18,height:18,border:"2.5px solid rgba(255,255,255,.4)",borderTop:"2.5px solid white",borderRadius:"50%"}}/>
            :step===3?"Create Account 🚀":"Continue →"}
        </button>
      </div>
      {errs.submit&&<p className="ferr" style={{marginTop:14,textAlign:"center"}}>{errs.submit}</p>}
      {step===0&&<>
        <div className="auth-divider"><span>or</span></div>
        <div style={{display:"flex",gap:10,marginBottom:24}}>
          <button className="btn-social" onClick={()=>startOAuth("google")} style={{flex:1}}>{Ic.google}Google</button>
          <button className="btn-social" onClick={()=>startOAuth("apple")} style={{flex:1}}>{Ic.apple}Apple</button>
        </div>
        <p style={{textAlign:"center",fontSize:14,color:T.light,fontWeight:600}}>Already have an account?{" "}<span style={{color:T.purple,fontWeight:800,cursor:"pointer"}} onClick={onSignIn}>Sign In</span></p>
      </>}
    </div>
  </div>;
}

/* ══════════════ FORGOT PASSWORD ══════════════ */
function ForgotPassword({onBack}){
  const [email,setEmail]=useState("");
  const [sent,setSent]=useState(false);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const submit=()=>{if(!validateEmail(email)){setErr("Enter a valid email");return;}setLoading(true);setTimeout(()=>{setLoading(false);setSent(true);},1200);};
  return <div className="auth-wrap"><SBar/>
    <div style={{flex:1,paddingTop:24,maxWidth:480,margin:"0 auto",width:"100%",padding:"24px 24px 40px",boxSizing:"border-box"}}>
      <button onClick={onBack} style={{background:"none",border:"none",cursor:"pointer",marginBottom:28,display:"flex",alignItems:"center",gap:6,color:T.mid,fontFamily:"Nunito",fontWeight:700,fontSize:14}}>{Ic.arrowL} Back to Sign In</button>
      {!sent?<>
        <div style={{fontSize:40,marginBottom:12}}>🔐</div>
        <p className="auth-logo">Forgot Password?</p>
        <p className="auth-sub" style={{marginBottom:36}}>We'll send a reset link to your email</p>
        <div style={{marginBottom:20}}>
          <label className="flabel">Email Address</label>
          <div className="inp-wrap"><span className="inp-icon">{Ic.mail}</span><input className={`inp inp-padl${err?" err":""}`} type="email" placeholder="you@example.com" value={email} onChange={e=>{setEmail(e.target.value);setErr("");}}/></div>
          {err&&<p className="ferr">{err}</p>}
        </div>
        <button className="btn btn-primary" onClick={submit} disabled={loading}>{loading?<span className="aSpin" style={{display:"inline-block",width:18,height:18,border:"2.5px solid rgba(255,255,255,.4)",borderTop:"2.5px solid white",borderRadius:"50%"}}/>:"Send Reset Link"}</button>
      </>:<div style={{textAlign:"center",paddingTop:40}}>
        <div style={{fontSize:64,marginBottom:20}}>📧</div>
        <p style={{fontSize:22,fontWeight:900,marginBottom:8}}>Check Your Email!</p>
        <p style={{fontSize:14,color:T.light,lineHeight:1.6,marginBottom:32}}>We sent a password reset link to <strong style={{color:T.text}}>{email}</strong></p>
        <button className="btn btn-primary" onClick={onBack}>Back to Sign In</button>
      </div>}
    </div>
  </div>;
}

/* ══════════════ DASHBOARD ══════════════ */
function Dashboard({user,setUser,meals,setMeals,water,setWater,toast,setTab,showSearch,openNotifs,hasUnreadNotifs,showAwards,playSfx,selectedDate,onSelectDate,isSyncingDate}){
  const [sheet,setSheet]=useState(null);
  const [weightLogVal,setWeightLogVal]=useState("");
  const [weightSaving,setWeightSaving]=useState(false);
  const [mealView,setMealView]=useState(null);
  const [mealBase,setMealBase]=useState(null);
  const [mealServingGrams,setMealServingGrams]=useState("100");
  const [dashWeightDelta,setDashWeightDelta]=useState(null);
  const [sportSensorLoading,setSportSensorLoading]=useState(true);
  const [sportSensorReady,setSportSensorReady]=useState(true);
  const [sportSensorReason,setSportSensorReason]=useState(null);
  const [sportData,setSportData]=useState({steps:0,distanceKm:0,calories:0,activeMinutes:0});
  const [animatedSteps,setAnimatedSteps]=useState(0);
  const stepAnimRef=useRef(null);
  const isDark=T.bg==="#0F0F1A";
  const todayKey=ymdLocal(new Date());
  const greeting=useMemo(()=>{
    const h=new Date().getHours();
    if(h>=5&&h<12)return "Good Morning";
    if(h>=12&&h<17)return "Good Afternoon";
    if(h>=17&&h<22)return "Good Evening";
    return "Good Night";
  },[]);
  const dashboardAvatar=(()=>{
    try{
      const n=parseInt(localStorage.getItem("nutriscan_avatar")||"0",10);
      if(Number.isFinite(n))return Math.min(Math.max(n,0),PROFILE_AVATARS.length-1);
      return 0;
    }catch(e){return 0;}
  })();
  const bmr=fBMR(user.gender,+user.weight,+user.height,+user.age);
  const tdee=fTDEE(bmr,user.activity);
  const target=fTarget(tdee,user.goal);
  const eaten=meals.reduce((a,m)=>a+m.cal,0);
  const left=target-eaten; const pct=eaten/target;
  const tP=Math.round(target*.25/4),tC=Math.round(target*.5/4),tF=Math.round(target*.25/9);
  const sP=meals.reduce((a,m)=>a+m.p,0),sC=meals.reduce((a,m)=>a+m.c,0),sF=meals.reduce((a,m)=>a+m.f,0);
  const bmi=parseFloat(fBMI(user.weight,user.height)),bi=fBMIlabel(bmi);
  const selectedDateLabel=formatSelectedDateLabel(selectedDate,todayKey);
  const selectedDateOptions=useMemo(()=>buildRelativeDateOptions(todayKey,5),[todayKey]);
  const selectedDateMealsTitle=selectedDateLabel==="Today"?"Today's Meals":`${selectedDateLabel}'s Meals`;
  const selectedDateIntakeTitle=selectedDateLabel==="Today"?"Today's Intake":`${selectedDateLabel} Intake`;
  const isSelectedDateSyncing=String(isSyncingDate||"").slice(0,10)===String(selectedDate||"").slice(0,10);
  const groups=["Breakfast","Lunch","Snack","Dinner"].map(n=>({n,items:meals.filter(m=>m.m===n),emoji:{Breakfast:"🌅",Lunch:"☀️",Snack:"🍎",Dinner:"🌙"}[n]}));
  const addRec=r=>{setMeals(p=>[...p,{id:Date.now(),name:r.n,cal:r.c,p:r.p||0,c:r.carb||0,f:r.f||0,t:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),e:r.e,m:"Snack"}]);playSfx&&playSfx("success");toast(`${r.n} added!`,"✅");setSheet(null);};
  const mealDetailPreview=useMemo(()=>{
    if(!mealView)return null;
    const base=mealBase||mealView;
    const grams=Math.max(1,Math.min(2000,parseFloat(mealServingGrams)||100));
    const factor=grams/100;
    return {
      ...mealView,
      cal:Math.max(0,Math.round((+base.cal||0)*factor)),
      p:Math.max(0,Math.round((+base.p||0)*factor*10)/10),
      c:Math.max(0,Math.round((+base.c||0)*factor*10)/10),
      f:Math.max(0,Math.round((+base.f||0)*factor*10)/10),
      serving_g:Math.round(grams),
    };
  },[mealBase,mealServingGrams,mealView]);
  useEffect(()=>{
    if(!user?.token||!user?.id){setDashWeightDelta(null);return;}
    let cancel=false;
    (async()=>{
      try{
        const rows=await supa.select(user.token,"weight_logs","weight,logged_at",`&user_id=eq.${user.id}&order=logged_at.asc`);
        if(cancel||!Array.isArray(rows)||rows.length<2){if(!cancel)setDashWeightDelta(null);return;}
        const first=+rows[0].weight,last=+rows[rows.length-1].weight;
        const d=Math.round((first-last)*10)/10;
        if(!cancel) setDashWeightDelta({d,pct:first?Math.round((d/first)*1000)/10:null});
      }catch(e){if(!cancel) setDashWeightDelta(null);}
    })();
    return()=>{cancel=true;};
  },[user?.id,user?.token,user?.weight]);

  const HEART=[{t:"00:00",bpm:62},{t:"06:00",bpm:68},{t:"08:00",bpm:95},{t:"12:00",bpm:82},{t:"15:00",bpm:88},{t:"18:00",bpm:92},{t:"20:00",bpm:74},{t:"00:00",bpm:64}];
  const SLEEP=[{d:"Mon",h:7.2},{d:"Tue",h:6.8},{d:"Wed",h:8.1},{d:"Thu",h:7.5},{d:"Fri",h:6.5},{d:"Sat",h:8.8},{d:"Sun",h:7.9}];
  const SPORT=[
    {name:"Steps",val:animatedSteps,max:10000,icon:"👟",color:T.mint,fmt:v=>v},
    {name:"Calories",val:sportData.calories,max:600,icon:"🔥",color:T.pink,fmt:v=>v},
    {name:"Active Min",val:sportData.activeMinutes,max:90,icon:"⏱️",color:T.lav,fmt:v=>v},
    {name:"Distance",val:sportData.distanceKm,max:8,icon:"📍",color:T.peach,fmt:v=>v.toFixed(1)},
  ];

  useEffect(()=>{
    if(!user?.id){
      setSportData({steps:0,distanceKm:0,calories:0,activeMinutes:0});
      setAnimatedSteps(0);
      setSportSensorReason(null);
      setSportSensorLoading(false);
      return;
    }
    const loaded=readSportDay(user.id,todayKey);
    setSportData(loaded);
    setAnimatedSteps(loaded.steps);
  },[user?.id,todayKey]);

  useEffect(()=>{
    if(stepAnimRef.current)cancelAnimationFrame(stepAnimRef.current);
    const target=Math.max(0,Math.round(+sportData.steps||0));
    const animate=()=>{
      setAnimatedSteps(prev=>{
        if(prev===target)return prev;
        const diff=target-prev;
        const step=Math.max(1,Math.ceil(Math.abs(diff)/8));
        const next=diff>0?Math.min(target,prev+step):Math.max(target,prev-step);
        if(next!==target)stepAnimRef.current=requestAnimationFrame(animate);
        return next;
      });
    };
    stepAnimRef.current=requestAnimationFrame(animate);
    return()=>{if(stepAnimRef.current)cancelAnimationFrame(stepAnimRef.current);};
  },[sportData.steps]);

  useEffect(()=>{
    if(!user?.id){setSportSensorLoading(false);return;}
    let active=true;
    let stopNative=null;

    const applyTotalSteps=(totalSteps)=>{
      if(!active||!user?.id)return;
      const todaySteps=resolveTodaySportSteps(user.id,todayKey,totalSteps);
      setSportData(deriveSportMetrics(todaySteps));
    };

    (async()=>{
      setSportSensorLoading(true);
      setSportSensorReason(null);
      if(!supportsNativeStepCounter()){
        if(active){
          setSportSensorReady(false);
          setSportSensorReason("platform");
          setSportSensorLoading(false);
        }
        return;
      }
      const started=await startNativeStepCounter((total)=>applyTotalSteps(total));
      if(!active)return;
      if(!started?.ok){
        setSportSensorReady(false);
        setSportSensorReason(started?.reason||"unavailable");
        setSportSensorLoading(false);
        if(started?.reason==="permission")toast("Allow Activity Recognition in Settings for live step tracking.","⚠️");
        return;
      }
      stopNative=started.stop;
      if(Number.isFinite(started.initialTotalSteps))applyTotalSteps(started.initialTotalSteps);
      setSportSensorReady(true);
      setSportSensorReason(null);
      setSportSensorLoading(false);
    })();

    return()=>{
      active=false;
      if(typeof stopNative==="function")stopNative();
    };
  },[todayKey,toast,user?.id]);

  return <div style={{paddingBottom:110}}>
    <SBar/>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"2px 16px 16px",maxWidth:600,margin:"0 auto",width:"100%"}}>
      <div style={{display:"flex",alignItems:"center",gap:11}}>
        <div className="avatar" style={{width:44,height:44,fontSize:17,boxShadow:`0 3px 10px ${T.shadow}`,background:"linear-gradient(135deg, #7B6FBF 0%, #9D93D8 100%)",overflow:"hidden"}}>
          {user?.profileImageUrl
            ?<img src={user.profileImageUrl} alt="Profile" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            :(user?.name?.[0]?.toUpperCase()||"U")}
        </div>
        <div><p style={{fontSize:12,color:T.light,fontWeight:600,lineHeight:1}}>{greeting},</p><p style={{fontSize:18,fontWeight:900,lineHeight:1.3}}>{user.name}</p></div>
      </div>
      <div style={{display:"flex",gap:9}}>
        <button className="btn-icon" onClick={showSearch}>{Ic.search}</button>
        <div style={{position:"relative"}}><button className="btn-icon" onClick={openNotifs}>{Ic.bell}</button>{hasUnreadNotifs&&<div style={{position:"absolute",top:8,right:8,width:8,height:8,borderRadius:"50%",background:T.red,border:`2px solid ${T.white}`}}/>}</div>
      </div>
    </div>
    <div style={{padding:"0 16px",display:"flex",flexDirection:"column",gap:14,maxWidth:600,margin:"0 auto",width:"100%"}}>
      {/* Calories card */}
      <div className="pcard" style={{background:T.pinkBg}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}><div style={{width:28,height:28,borderRadius:8,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 2px 6px ${T.shadow}`}}>{Ic.trend}</div><span style={{fontSize:14,fontWeight:800}}>Breakfast</span><span style={{fontSize:13,fontWeight:600,color:T.light}}>{eaten} cal</span></div></div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn-icon" style={{width:34,height:34,borderRadius:10}} onClick={()=>setTab("scanner")}>{Ic.plus}</button>
            <button className="btn-icon" style={{width:34,height:34,borderRadius:10}} onClick={()=>setSheet("goalEdit")}>{Ic.edit}</button>
          </div>
        </div>
        <div style={{background:T.white,borderRadius:16,padding:"14px 10px",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4}}>
          {[{l:"Proteins",v:sP,u:"g",c:T.blue},{l:"Fats",v:sF,u:"g",c:"#F0A060"},{l:"Carbs",v:sC,u:"g",c:T.green},{l:"RDC",v:`${Math.round(pct*100)}%`,u:"",c:T.purple}].map(m=>(
            <div key={m.l} style={{textAlign:"center"}}><p style={{fontSize:17,fontWeight:900,color:m.c,lineHeight:1}}>{m.v}<span style={{fontSize:10}}>{m.u}</span></p><p style={{fontSize:10,color:T.light,fontWeight:600,marginTop:3}}>{m.l}</p></div>
          ))}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:12}}>
          <button className="badge" style={{background:T.white,color:T.mid,border:"none",cursor:"pointer",fontFamily:"Nunito",display:"inline-flex",alignItems:"center",gap:6}} onClick={()=>setSheet("dateMenu")}>
            {isSelectedDateSyncing&&<span className="aSpin" style={{display:"inline-block",width:12,height:12,border:`2px solid ${T.border}`,borderTop:`2px solid ${T.purple}`,borderRadius:"50%"}}/>}
            <span>{selectedDateLabel} ▾</span>
          </button>
          <span style={{fontSize:13,fontWeight:700,color:left>0?T.green:T.red}}>{left>0?`${left} remaining`:`${Math.abs(left)} over`}</span>
        </div>
      </div>
      {/* 4-grid */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        {[{title:"Sport Data",sub:`${sportData.steps} steps · ${sportData.distanceKm.toFixed(1)} km`,icon:"📊",bg:T.peachBg,key:"sport"},{title:"Hydration",sub:`${water}/8 glasses · ${water*250}ml`,icon:"💧",bg:T.lavBg,key:"hydration"},{title:"Sleep Quality",sub:"Check Your Sleep Quality",icon:"😴",bg:T.mintBg,key:"sleep"},{title:"BMI",sub:`BMI: ${bmi} — ${bi.l}`,icon:"⚖️",bg:T.pinkBg,key:"bmi"}].map(c=>(
          <div key={c.key} className="pcard hover-card" style={{background:c.bg,padding:"16px"}} onClick={()=>setSheet(c.key)}>
                        <div style={{display:"flex",justifyContent:"space-between"}}><div style={{width:36,height:36,borderRadius:10,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,boxShadow:`0 2px 6px ${T.shadow}`}}>{c.icon}</div><div style={{width:26,height:26,borderRadius:8,background:isDark?"rgba(108,168,255,.22)":"rgba(255,255,255,.6)",display:"flex",alignItems:"center",justifyContent:"center",color:isDark?T.blue:T.mid,border:isDark?`1px solid ${T.blue}55`:"none"}}>{Ic.trend}</div></div>
            <p style={{fontSize:14,fontWeight:800,marginTop:12,lineHeight:1.2}}>{c.title}</p>
            <p style={{fontSize:11,color:T.mid,fontWeight:500,marginTop:4,lineHeight:1.4}}>{c.sub}</p>
            <button className="check-link" style={{marginTop:14}}>Check {Ic.arrowR}</button>
          </div>
        ))}
      </div>
      {/* Progress ring */}
      <div className="pcard" style={{background:T.lavBg}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}><div style={{width:28,height:28,borderRadius:8,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 2px 6px ${T.shadow}`}}>{Ic.trend}</div><span style={{fontSize:14,fontWeight:800}}>Your Progress</span></div><p style={{fontSize:40,fontWeight:900,lineHeight:1}}>{Math.round(pct*100)}%</p><p style={{fontSize:13,color:T.mid,fontWeight:600,marginTop:6}}>{new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long"})} ▾</p></div>
          <Ring pct={pct} size={112} sw={11} color={T.purple} track="rgba(255,255,255,.7)">
            <div style={{textAlign:"center"}}><p style={{fontSize:14,fontWeight:900,lineHeight:1}}>{eaten}</p><p style={{fontSize:10,fontWeight:700,color:T.mid}}>Calories</p>{pct>0.9&&<div style={{fontSize:14,marginTop:2}}>🔥</div>}</div>
          </Ring>
        </div>
      </div>
      {/* Activity + weight */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div className="card hover-card" style={{padding:"16px"}} onClick={showAwards}>
          <p style={{fontSize:13,fontWeight:800,marginBottom:4}}>Achievement</p>
          <p style={{fontSize:11,color:T.light,lineHeight:1.4,fontWeight:500,marginBottom:10}}>View your milestones and rewards.</p>
          <div style={{height:58,borderRadius:12,background:`linear-gradient(135deg,${T.lavBg},${T.mintBg})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>🏆</div>
          <button className="btn btn-primary" style={{marginTop:10,borderRadius:12,padding:"10px 14px",fontSize:13}} onClick={e=>{e.stopPropagation();showAwards();}}>Open</button>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div className="card hover-card" style={{padding:"14px"}} onClick={()=>setSheet("bmi")}>
            <div style={{display:"flex",justifyContent:"space-between"}}><div><p style={{fontSize:11,fontWeight:700,color:T.light,marginBottom:4}}>Current Weight</p><p style={{fontSize:20,fontWeight:900}}>{user.weight} <span style={{fontSize:12,color:T.mid}}>kg</span></p></div><div style={{color:T.mid}}>{Ic.trendUp}</div></div>
            <div style={{display:"flex",alignItems:"center",gap:5,marginTop:8}}>
              {dashWeightDelta!=null&&dashWeightDelta.d!==0
                ?<><div style={{width:7,height:7,borderRadius:"50%",background:dashWeightDelta.d>0?T.green:T.orange}}/>
                  <span style={{fontSize:11,fontWeight:700,color:dashWeightDelta.d>0?T.green:T.orange}}>
                    {dashWeightDelta.d>0?`↓ ${dashWeightDelta.d} kg`:`↑ ${-dashWeightDelta.d} kg`}{dashWeightDelta.pct!=null?` (${dashWeightDelta.d>0?"−":"+"}${Math.abs(dashWeightDelta.pct)}%)`:""}
                  </span></>
                :<span style={{fontSize:11,fontWeight:600,color:T.light}}>Log weight to track change</span>}
            </div>
          </div>
          <div className="card hover-card" style={{padding:"14px"}} onClick={()=>setTab("analytics")}>
            <div style={{display:"flex",justifyContent:"space-between"}}><div><p style={{fontSize:11,fontWeight:700,color:T.light,marginBottom:4}}>{selectedDateLabel} Calories</p><p style={{fontSize:20,fontWeight:900}}>{eaten} <span style={{fontSize:12,color:T.mid}}>kcal</span></p></div><div style={{color:T.green}}>{Ic.trendUp}</div></div>
            <div style={{display:"flex",alignItems:"center",gap:5,marginTop:8}}><div style={{width:7,height:7,borderRadius:"50%",background:T.green}}/><span style={{fontSize:11,fontWeight:700,color:T.green}}>On track today</span></div>
          </div>
        </div>
      </div>

      {/* Meals */}
      <div>
        <div className="sec-hdr"><p className="sec-title">{selectedDateMealsTitle}</p><button className="sec-link" onClick={()=>setTab("scanner")}>+ Add</button></div>
        {groups.map(g=>g.items.length>0&&<div key={g.n} style={{marginBottom:14}}>
          <p style={{fontSize:11,fontWeight:700,color:T.light,textTransform:"uppercase",letterSpacing:1.1,marginBottom:8}}>{g.emoji} {g.n}</p>
          {g.items.map(m=><div key={m.id} className="meal-row" style={{marginBottom:8}} onClick={()=>{setMealView(m);setMealBase(m);setMealServingGrams(String(Math.max(1,Math.round(Number(m?.serving_g)||100))));setSheet("mealDetail");}}>
            <div style={{width:44,height:44,borderRadius:13,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,boxShadow:`0 2px 8px ${T.shadow}`}}>{m.e}</div>
            <div style={{flex:1}}><p style={{fontSize:14,fontWeight:700}}>{m.name}</p><p style={{fontSize:11,color:T.light,marginTop:2}}>P:{m.p}g · C:{m.c}g · F:{m.f}g</p></div>
            <div style={{textAlign:"right"}}><p style={{fontSize:15,fontWeight:900,color:T.purple}}>{m.cal}</p><p style={{fontSize:10,color:T.light}}>kcal</p></div>
          </div>)}
        </div>)}
      </div>
      {/* Macros */}
      <div className="card"><p style={{fontSize:15,fontWeight:800,marginBottom:16}}>Macro Progress</p><MacroBar label="Protein" cur={sP} max={tP} color={T.blue}/><MacroBar label="Carbohydrates" cur={sC} max={tC} color={T.green}/><MacroBar label="Fat" cur={sF} max={tF} color="#F0A060"/></div>
      {/* Recs */}
      <div>
        <div className="sec-hdr"><p className="sec-title">Today Recommendation</p><button className="sec-link" onClick={()=>setSheet("allRecs")}>See all</button></div>
        <div style={{display:"flex",gap:12,overflowX:"auto",paddingBottom:4}}>
          {RECS.slice(0,4).map((r,i)=><div key={i} className="hover-card" style={{minWidth:128,padding:"16px",borderRadius:20,background:r.bg,flexShrink:0,boxShadow:`0 3px 10px ${T.shadow}`}} onClick={()=>addRec(r)}>
            <div style={{fontSize:36,marginBottom:10}}>{r.e}</div>
            <p style={{fontSize:14,fontWeight:800,color:LIGHT.navy}}>{r.n}</p>
            <p style={{fontSize:12,color:LIGHT.mid,fontWeight:700,marginTop:3}}>{r.c} kcal</p>
            <div style={{fontSize:10,color:LIGHT.purple,fontWeight:700,marginTop:6}}>Tap to add +</div>
          </div>)}
        </div>
      </div>
      {/* Bottom sport+hydration */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:4}}>
        <div className="pcard hover-card" style={{background:T.peachBg,padding:"16px"}} onClick={()=>setSheet("sport")}><div style={{display:"flex",justifyContent:"space-between"}}><div style={{width:32,height:32,borderRadius:9,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>📊</div><div style={{color:isDark?T.blue:T.mid}}>{Ic.trend}</div></div><p style={{fontSize:14,fontWeight:800,marginTop:10}}>Sport Data</p><p style={{fontSize:11,color:T.mid,fontWeight:500,marginTop:3,lineHeight:1.4}}>{sportData.steps} steps · {sportData.activeMinutes} min active</p><button className="check-link" style={{marginTop:12}}>Check {Ic.arrowR}</button></div>
        <div className="pcard hover-card" style={{background:T.lavBg,padding:"16px"}} onClick={()=>setSheet("hydration")}><div style={{display:"flex",justifyContent:"space-between"}}><div style={{width:32,height:32,borderRadius:9,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>💧</div><div style={{color:T.purple}}>{Ic.drop}</div></div><p style={{fontSize:14,fontWeight:800,marginTop:10}}>Hydration</p><p style={{fontSize:11,color:T.mid,fontWeight:500,marginTop:3,lineHeight:1.4}}>{water}/8 glasses · {water*250}ml</p><button className="check-link" style={{marginTop:12}}>Check {Ic.arrowR}</button></div>
      </div>
    </div>

    {/* SHEETS */}
    {sheet==="sport"&&<Sheet title="🏃 Sport Data" onClose={()=>setSheet(null)}>
      {sportSensorLoading&&<div style={{textAlign:"center",padding:"10px 0 16px"}}><div className="aSpin" style={{width:28,height:28,border:`3px solid ${T.lav}`,borderTop:`3px solid ${T.purple}`,borderRadius:"50%",margin:"0 auto 10px"}}/><p style={{fontSize:12,color:T.mid,fontWeight:700}}>Connecting step sensor…</p></div>}
      {!sportSensorLoading&&!sportSensorReady&&<p style={{fontSize:12,color:T.red,fontWeight:700,marginBottom:12}}>{sportSensorReason==="permission"?"Activity Recognition is denied. Enable it in phone Settings → Apps → NutriScan → Permissions.":sportSensorReason==="platform"?"Step tracking is available on Android native app only.":"Step counter sensor unavailable. Reopen the app after enabling permissions."}</p>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>
        {SPORT.map(s=><div key={s.name} className="pcard" style={{background:s.color+"33",padding:"16px"}}><p style={{fontSize:22}}>{s.icon}</p><p style={{fontSize:22,fontWeight:900,marginTop:8}}>{s.fmt(s.val)}<span style={{fontSize:12,color:T.mid,fontWeight:600}}> /{s.max}</span></p><p style={{fontSize:12,color:T.mid,fontWeight:600,marginTop:2}}>{s.name}</p><div className="mbar" style={{marginTop:10}}><div className="mbar-f" style={{width:`${Math.min(100,(s.val/s.max)*100)}%`,background:s.color}}/></div></div>)}
      </div>
      <div className="card" style={{marginBottom:14}}><p style={{fontSize:14,fontWeight:800,marginBottom:14}}>Steps This Week</p><ResponsiveContainer width="100%" height={140}><BarChart data={dateRangeInclusive(todayKey,7).map(d=>({d:new Date(d+"T12:00:00").toLocaleDateString("en-IN",{weekday:"narrow"}),v:readSportDay(user.id,d).steps}))} margin={{top:5,right:5,bottom:0,left:-24}}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis dataKey="d" tick={{fill:T.light,fontSize:11,fontFamily:"Nunito",fontWeight:600}}/><YAxis tick={{fill:T.light,fontSize:10,fontFamily:"Nunito"}}/><Tooltip contentStyle={{background:T.white,border:`1px solid ${T.border}`,borderRadius:12,fontFamily:"Nunito"}} formatter={v=>[`${v} steps`]}/><Bar dataKey="v" fill={T.mint} radius={[6,6,0,0]}/></BarChart></ResponsiveContainer></div>
      <button className="btn btn-primary" onClick={()=>{toast("Workout logged! 💪","✅");setSheet(null);}}>+ Log Today's Workout</button>
    </Sheet>}

    {sheet==="hydration"&&<Sheet title="💧 Hydration" onClose={()=>setSheet(null)}>
      {/* Hero */}
      <div style={{textAlign:"center",padding:"6px 0 10px"}}>
        <div style={{fontSize:48,marginBottom:4}}>💧</div>
        <p style={{fontSize:32,fontWeight:900,lineHeight:1}}>{water}<span style={{fontSize:14,color:T.mid,fontWeight:600}}>/8 glasses</span></p>
        <p style={{fontSize:13,color:T.mid,fontWeight:600,marginTop:3}}>{water*250}ml · {water>=8?"Goal reached! 🏆":`${(8-water)*250}ml to go`}</p>
      </div>
      {/* Stats row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
        {[{l:"Consumed",v:`${water*250}ml`,c:T.lav,i:"💧"},{l:"Remaining",v:`${Math.max(0,(8-water)*250)}ml`,c:T.mint,i:"🎯"},{l:"Goal",v:"2000ml",c:T.peach,i:"⭐"}].map(s=>(
          <div key={s.l} style={{textAlign:"center",padding:"10px 6px",borderRadius:14,background:s.c+"55"}}>
            <p style={{fontSize:18}}>{s.i}</p>
            <p style={{fontSize:13,fontWeight:900,marginTop:4}}>{s.v}</p>
            <p style={{fontSize:10,color:T.mid,fontWeight:600,marginTop:1}}>{s.l}</p>
          </div>
        ))}
      </div>
      {/* Drops + progress */}
      <div className="card" style={{marginBottom:12,padding:14}}>
        <p style={{fontSize:13,fontWeight:800,marginBottom:10}}>{selectedDateIntakeTitle}</p>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center",marginBottom:10}}>
          {Array.from({length:8},(_,i)=>(
            <div key={i} className={`wdrop ${i<water?"on":"off"}`} style={{width:32,height:32}} onClick={()=>{const nw=i<water?i:i+1;setWater(nw);if(nw===8)toast("💧 Hydration goal reached!","🏆");}}>
              <span style={{transform:"rotate(45deg)",fontSize:12}}>{i<water?"💧":"·"}</span>
            </div>
          ))}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><span style={{fontSize:11,fontWeight:600,color:T.mid}}>Progress</span><span style={{fontSize:11,fontWeight:700,color:T.purple}}>{Math.round((water/8)*100)}%</span></div>
        <div className="mbar"><div className="mbar-f" style={{width:`${(water/8)*100}%`,background:T.lav}}/></div>
      </div>
      {/* Actions */}
      <div style={{display:"flex",gap:10}}>
        <button className="btn-soft" style={{flex:1}} onClick={()=>{setWater(w=>Math.min(8,w+1));toast("Glass logged! 💧","💧");}}>+ Add Glass</button>
        <button className="btn btn-primary" style={{flex:1}} onClick={()=>{toast("Reminder set! ⏰","💧");setSheet(null);}}>Set Reminder</button>
      </div>
    </Sheet>}

    {sheet==="sleep"&&<Sheet title="😴 Sleep Quality" onClose={()=>setSheet(null)}>
      <div style={{textAlign:"center",padding:"20px 0",marginBottom:18}}>
        <div style={{fontSize:64,marginBottom:12}}>🌙</div>
        <p style={{fontSize:36,fontWeight:900}}>7.9 <span style={{fontSize:16,color:T.mid,fontWeight:600}}>hrs</span></p>
        <p style={{fontSize:14,color:T.mid,fontWeight:600,marginTop:4}}>Last night · Excellent</p>
        <div style={{display:"flex",justifyContent:"center",gap:20,marginTop:16}}>{[{l:"Deep",v:"2.1h",c:T.purple},{l:"Light",v:"3.8h",c:T.lav},{l:"REM",v:"2.0h",c:T.mint}].map(s=><div key={s.l} style={{textAlign:"center"}}><div style={{width:10,height:10,borderRadius:"50%",background:s.c,margin:"0 auto 6px"}}/><p style={{fontSize:16,fontWeight:800,color:s.c}}>{s.v}</p><p style={{fontSize:11,color:T.light}}>{s.l}</p></div>)}</div>
      </div>
      <div className="card" style={{marginBottom:14}}><p style={{fontSize:14,fontWeight:800,marginBottom:14}}>Sleep This Week</p><ResponsiveContainer width="100%" height={140}><BarChart data={SLEEP} margin={{top:5,right:5,bottom:0,left:-24}}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis dataKey="d" tick={{fill:T.light,fontSize:11,fontFamily:"Nunito",fontWeight:600}}/><YAxis tick={{fill:T.light,fontSize:10,fontFamily:"Nunito"}} domain={[5,10]}/><Tooltip contentStyle={{background:T.white,border:`1px solid ${T.border}`,borderRadius:12,fontFamily:"Nunito"}} formatter={v=>[`${v}h`]}/><Bar dataKey="h" fill={T.lav} radius={[6,6,0,0]}/></BarChart></ResponsiveContainer></div>
      <button className="btn btn-primary" onClick={()=>{setSheet(null);setTab("settings");toast("Set your sleep reminder time in Settings → Notifications","🌙");}}>Set Sleep Reminder</button>
    </Sheet>}

    {sheet==="bmi"&&<Sheet title="⚖️ BMI & Body" onClose={()=>{setSheet(null);setWeightLogVal("");}}>
      <div style={{textAlign:"center",padding:"16px 0 20px"}}>
        <div style={{width:100,height:100,borderRadius:"50%",margin:"0 auto 14px",background:`${bi.c}20`,border:`3px solid ${bi.c}`,display:"flex",alignItems:"center",justifyContent:"center"}}><p style={{fontSize:32,fontWeight:900,color:bi.c}}>{bmi}</p></div>
        <p style={{fontSize:20,fontWeight:900,color:bi.c}}>{bi.l}</p>
        <p style={{fontSize:13,color:T.light,marginTop:4}}>Body Mass Index</p>
      </div>
      <div style={{position:"relative",height:24,borderRadius:12,overflow:"hidden",background:`linear-gradient(90deg,${T.blue},${T.green},#F0A840,${T.red})`,marginBottom:8}}>
        <div style={{position:"absolute",top:-2,width:16,height:28,borderRadius:4,background:T.navy,left:`${Math.min(Math.max((bmi-15)/25*100,2),96)}%`,transform:"translateX(-50%)"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.light,fontWeight:700,marginBottom:20}}><span>15 Underweight</span><span>25 Normal</span><span>30 Over</span><span>40</span></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
        {[{l:"Current Weight",v:`${user.weight} kg`},{l:"Height",v:`${user.height} cm`},{l:"Ideal Weight",v:`${Math.round(22.5*(user.height/100)**2)} kg`},{l:"Weight to Goal",v:`${Math.abs(Math.round(22.5*(user.height/100)**2-user.weight))} kg`}].map(s=><div key={s.l} style={{padding:"12px",background:T.bg,borderRadius:14}}><p style={{fontSize:11,color:T.light,fontWeight:600}}>{s.l}</p><p style={{fontSize:18,fontWeight:900,marginTop:2}}>{s.v}</p></div>)}
      </div>
      <p style={{fontSize:13,fontWeight:700,marginBottom:8}}>Log today&apos;s weight (kg)</p>
      <input className="inp" type="number" step="0.1" placeholder={`e.g. ${user.weight}`} value={weightLogVal} onChange={e=>setWeightLogVal(e.target.value)} style={{marginBottom:12}}/>
      <button className="btn btn-primary" disabled={weightSaving||!user?.token} onClick={async()=>{
        const w=parseFloat(weightLogVal);
        const wRounded=Math.round(w*10)/10;
        if(!isFinite(wRounded)||wRounded<=0||wRounded>250){toast("Enter a valid weight (kg)","❌");return;}
        const currentW=parseFloat(user.weight);
        if(isFinite(currentW)&&Math.abs(wRounded-currentW)>15){
          const proceed=typeof window!=="undefined"?window.confirm(`This is a ${Math.abs(wRounded-currentW).toFixed(1)}kg change. Save anyway?`):true;
          if(!proceed)return;
        }
        setWeightSaving(true);
        const today=ymdLocal(new Date());
        try{
          await supa.upsert(user.token,"weight_logs",{user_id:user.id,weight:wRounded,logged_at:today});
          await supa.patch(user.token,"profiles",`id=eq.${user.id}`,{weight:wRounded});
          setUser(u=>({...u,weight:String(wRounded)}));
          toast("Weight saved!","⚖️");
          setWeightLogVal("");
          setSheet(null);
        }catch(e){toast("Couldn't save weight","❌");}
        setWeightSaving(false);
      }}>{weightSaving?"Saving…":"+ Log Today&apos;s Weight"}</button>
    </Sheet>}

    {sheet==="mealDetail"&&mealView&&<Sheet title={mealView.name} onClose={()=>{setSheet(null);setMealView(null);setMealBase(null);setMealServingGrams("100");}}>
      <div style={{textAlign:"center",marginBottom:20}}><div style={{fontSize:60,marginBottom:8}}>{mealView.e}</div><p style={{fontSize:32,fontWeight:900,color:T.purple}}>{mealDetailPreview?.cal||mealView.cal} kcal</p><p style={{fontSize:13,color:T.light,marginTop:4}}>{mealView.m} · {mealView.t}</p></div>
      <div style={{marginBottom:14}}>
        <p style={{fontSize:12,fontWeight:700,color:T.mid,marginBottom:6}}>Serving Size (g)</p>
        <input className="inp" type="number" min="1" max="2000" value={mealServingGrams} onChange={e=>setMealServingGrams(e.target.value)} />
        <p style={{fontSize:11,color:T.light,fontWeight:600,marginTop:6}}>Nutrition is scaled from your saved meal amount.</p>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:20}}>
        {[{l:"Protein",v:mealDetailPreview?.p??mealView.p,c:T.blue,bg:T.lavBg},{l:"Carbs",v:mealDetailPreview?.c??mealView.c,c:T.green,bg:T.mintBg},{l:"Fat",v:mealDetailPreview?.f??mealView.f,c:"#F0A060",bg:T.peachBg}].map(m=><div key={m.l} style={{textAlign:"center",padding:14,borderRadius:14,background:m.bg}}><p style={{fontSize:20,fontWeight:900,color:m.c}}>{m.v}g</p><p style={{fontSize:11,fontWeight:600,color:T.light}}>{m.l}</p></div>)}
      </div>
      <button className="btn-soft" style={{marginBottom:10}} onClick={()=>{
        if(!mealDetailPreview)return;
        setMeals(p=>p.map(m=>m.id===mealView.id?{...m,cal:mealDetailPreview.cal,p:mealDetailPreview.p,c:mealDetailPreview.c,f:mealDetailPreview.f,serving_g:mealDetailPreview.serving_g}:m));
        setMealView(v=>v?{...v,cal:mealDetailPreview.cal,p:mealDetailPreview.p,c:mealDetailPreview.c,f:mealDetailPreview.f,serving_g:mealDetailPreview.serving_g}:v);
        setMealBase(v=>v?{...v,cal:mealDetailPreview.cal,p:mealDetailPreview.p,c:mealDetailPreview.c,f:mealDetailPreview.f}:v);
        setMealServingGrams("100");
        toast("Serving updated","✅");
      }}>Save Serving</button>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-ghost" style={{flex:1,border:`2px solid ${T.red}`,color:T.red}} onClick={()=>{setMeals(p=>p.filter(m=>m.id!==mealView.id));toast("Meal removed","🗑️");setSheet(null);setMealView(null);setMealBase(null);setMealServingGrams("100");}}>🗑️ Remove</button>
        <button className="btn btn-primary" style={{flex:1}} onClick={()=>{const mealToAdd=mealDetailPreview||mealView;setMeals(p=>[...p,{...mealToAdd,id:Date.now(),t:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}]);toast(`${mealView.name} added again!`,"✅");setSheet(null);setMealBase(null);setMealServingGrams("100");}}>+ Add Again</button>
      </div>
    </Sheet>}

    {sheet==="allRecs"&&<Sheet title="🍽️ All Recommendations" onClose={()=>setSheet(null)}>
      <p style={{fontSize:13,color:T.light,marginBottom:16}}>Tap any meal to add it to your log</p>
      {RECS.map((r,i)=><div key={i} className="meal-row" style={{marginBottom:8,background:r.bg}} onClick={()=>addRec(r)}>
        <div style={{width:46,height:46,borderRadius:14,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,boxShadow:`0 2px 6px ${T.shadow}`}}>{r.e}</div>
        <div style={{flex:1}}><p style={{fontSize:14,fontWeight:700}}>{r.n}</p><p style={{fontSize:11,color:T.light}}>P:{r.p}g · Carbs:{r.carb}g · F:{r.f}g</p></div>
        <div style={{textAlign:"right"}}><p style={{fontSize:16,fontWeight:900,color:T.purple}}>{r.c}</p><p style={{fontSize:10,color:T.light}}>kcal</p></div>
      </div>)}
    </Sheet>}

    {sheet==="goalEdit"&&<Sheet title="✏️ Edit Calorie Goal" onClose={()=>setSheet(null)}>
      <p style={{fontSize:14,color:T.mid,marginBottom:16}}>Calculated target: <strong style={{color:T.purple}}>{target} kcal</strong></p>
      <label className="flabel">Custom Daily Goal (kcal)</label>
      <input className="inp" type="number" defaultValue={target} style={{marginBottom:20}} id="goalInp"/>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-ghost" style={{flex:1,border:"2px solid "+T.border}} onClick={()=>{toast("Reset to auto target","🔄");setSheet(null);}}>Reset</button>
        <button className="btn btn-primary" style={{flex:1}} onClick={()=>{toast("Goal updated!","🎯");setSheet(null);}}>Save Goal</button>
      </div>
    </Sheet>}

    {sheet==="dateMenu"&&<Sheet title="📅 Select Date" onClose={()=>setSheet(null)}>
      {selectedDateOptions.map(opt=>{
        const active=opt.date===selectedDate;
        return <div key={opt.date} onClick={()=>{onSelectDate&&onSelectDate(opt.date);toast(`Viewing ${opt.label}'s log`,"📅");setSheet(null);}} style={{padding:"14px",borderRadius:14,marginBottom:8,background:active?T.lavBg:T.bg,border:`2px solid ${active?T.purple:T.border}`,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",fontWeight:active?800:600,transition:"all .18s"}}><span>{opt.label}</span>{active&&<span style={{color:T.purple}}>✓</span>}</div>;
      })}
    </Sheet>}
  </div>;
}

/* ══════════════ SCANNER ══════════════ */
function Scanner({onAddMeal,toast,user,online=true,playSfx}){
  const [mode,setMode]=useState(online?"search":"manual"); // search|camera|manual|barcode
  useEffect(()=>{
    if(!online&&mode!=="manual")setMode("manual");
  },[online,mode]);
  const setModeSafe=(id)=>{
    if(!online&&id!=="manual"){toast("Connect to the internet for search, barcode & AI scan. Manual entry works offline.","📡");return;}
    setMode(id);
  };
  const [res,setRes]=useState(null);
  const [part,setPart]=useState(1);
  const [added,setAdded]=useState(false);
  const [mealType,setMealType]=useState("Lunch");

  // ── SEARCH state ──
  const [searchQ,setSearchQ]=useState("");
  const [searchResults,setSearchResults]=useState([]);
  const [searchAllResults,setSearchAllResults]=useState([]); // all loaded results for pagination
  const [searchSections,setSearchSections]=useState({best:[],local:[],related:[]});
  const [searchLoading,setSearchLoading]=useState(false);
  const [searchDone,setSearchDone]=useState(false);
  const [searchOffset,setSearchOffset]=useState(0); // pagination offset
  const [searchHasMore,setSearchHasMore]=useState(false); // more results available
  const [searchLastQuery,setSearchLastQuery]=useState(""); // cache for Load More
  const [searchLastLocale,setSearchLastLocale]=useState(null); // cache for Load More
  const [searchLoadingMore,setSearchLoadingMore]=useState(false); // separate loading state for Load More
  const [searchDisplayLimit]=useState(10); // show 10 results per page
  const [expandedSearchId,setExpandedSearchId]=useState(null);
  const [searchPortions,setSearchPortions]=useState({});
  const [searchMeals,setSearchMeals]=useState({});
  const [searchAddedId,setSearchAddedId]=useState(null);

  // ── MANUAL state ──
  const [manual,setManual]=useState({name:"",cal:"",p:"",c:"",f:"",e:"🍽️"});
  const [manualErr,setManualErr]=useState("");

  // ── BARCODE state ──
  const videoRef=useRef(null);
  const streamRef=useRef(null);
  const intervalRef=useRef(null);
  const [camErr,setCamErr]=useState("");
  const [barcodeLoading,setBarcodeLoading]=useState(false);
  const [barcodeStatus,setBarcodeStatus]=useState("idle");
  const [barcodeInput,setBarcodeInput]=useState("");
  const barcodeStartRef=useRef(0);
  const barcodeOpenTimeoutRef=useRef(null);
  const barcodeStatusRef=useRef("idle");
  const nativeBarcodePreviewRef=useRef(false);
  const nativeBarcodeScanTimerRef=useRef(null);
  const nativeBarcodeScanBusyRef=useRef(false);

  // ── CAMERA/AI state ──
  const [scan,setScan]=useState(false);
  const [aiScanStatus,setAiScanStatus]=useState("idle"); // "idle" | "loading" | "scanning"
  const videoAiRef=useRef(null);
  const streamAiRef=useRef(null);
  const canvasRef=useRef(null);
  const aiScanStartRef=useRef(null);

  const EMOJIS=["🍽️","🥗","🍛","🍜","🍕","🍔","🥩","🐟","🥚","🧀","🥛","🍞","🥦","🍎","🍌","🍗","🥤","🍣","🍝","🥙"];
  const barcodeFormats=["ean_13","ean_8","upc_a","upc_e","code_128","code_39","qr_code"];

  useEffect(()=>{barcodeStatusRef.current=barcodeStatus;},[barcodeStatus]);

  const readNativeCaptureDataUrl=(captureResult)=>{
    const raw=String(captureResult?.value||captureResult?.base64String||captureResult?.data||"");
    if(!raw)return"";
    if(/^data:image\//i.test(raw))return raw;
    return `data:image/jpeg;base64,${raw}`;
  };

  const detectBarcodeFromDataUrl=async(dataUrl,detector)=>{
    if(!dataUrl||!detector)return null;
    return await new Promise(resolve=>{
      const img=new Image();
      img.onload=async()=>{
        try{
          const codes=await detector.detect(img);
          resolve(codes?.length?String(codes[0].rawValue||""):null);
        }catch(e){resolve(null);}
      };
      img.onerror=()=>resolve(null);
      img.src=dataUrl;
    });
  };

  const waitForBarcodePreviewHost=async(maxTries=30)=>{
    for(let i=0;i<maxTries;i++){
      const host=document.getElementById("barcode-preview-host");
      if(host)return host;
      await new Promise(r=>setTimeout(r,50));
    }
    return null;
  };

  const stopNativeBarcodePreview=async()=>{
    if(nativeBarcodeScanTimerRef.current){clearInterval(nativeBarcodeScanTimerRef.current);nativeBarcodeScanTimerRef.current=null;}
    nativeBarcodeScanBusyRef.current=false;
    if(nativeBarcodePreviewRef.current){
      nativeBarcodePreviewRef.current=false;
      try{await CameraPreview.stop();}catch(e){}
    }
  };

  // ── Supabase food search (location-aware sectioned) ──
  const resolveSearchLocale=()=>{
    const userCountryRaw=String(user?.country||"").trim().toLowerCase();
    const userStateRaw=String(user?.state||"").trim().toLowerCase();
    let country=userCountryRaw;
    if(country==="in")country="india";
    if(!country){
      try{
        const tz=Intl.DateTimeFormat().resolvedOptions().timeZone||"";
        if(/kolkata/i.test(tz))country="india";
      }catch(e){}
    }
    return {country,state:userStateRaw};
  };

  const resolveLocalPriority=({country,state})=>{
    if(state==="manipur")return 1;
    if(country==="india")return 2;
    if(country)return 3;
    return 2;
  };

  const bucketSearchSections=(rows)=>{
    const locale=resolveSearchLocale();
    const localPriority=resolveLocalPriority(locale);
    const best=[];
    const local=[];
    const related=[];
    const bestIds=new Set();

    (rows||[]).forEach(item=>{
      if(item.matchType==="related")related.push(item);
      else if(best.length<6){best.push(item);bestIds.add(item.id);}
    });

    (rows||[]).forEach(item=>{
      if(item.matchType==="related")return;
      if(item.priority===localPriority&&!bestIds.has(item.id)&&local.length<4){
        local.push(item);
      }
    });

    return {best,local,related};
  };

  const mapFoodRows=(rows)=>{
    return (rows||[]).map(r=>({
      id:r.id,
      name:r.name,
      category:r.category||"",
      country:r.country||"",
      priority:+r.priority||2,
      matchType:r.match_type||"name",
      cal:Math.round(+r.calories||0),
      p:Math.round((+r.protein||0)*10)/10,
      c:0,
      f:0,
      emoji:"🍽️",
      source:"search",
    }));
  };

  const readLocalSearchCache=(cacheKey)=>{
    try{
      const raw=localStorage.getItem(FOOD_SEARCH_CACHE_KEY);
      if(!raw)return null;
      const store=JSON.parse(raw);
      const entry=store?.[cacheKey];
      if(!entry||!Array.isArray(entry.rows)||!entry.ts)return null;
      if(Date.now()-entry.ts>FOOD_SEARCH_CACHE_TTL_MS)return null;
      return entry.rows;
    }catch(e){
      return null;
    }
  };

  const writeLocalSearchCache=(cacheKey,rows)=>{
    try{
      const raw=localStorage.getItem(FOOD_SEARCH_CACHE_KEY);
      const store=raw?JSON.parse(raw):{};
      store[cacheKey]={ts:Date.now(),rows};
      const keys=Object.keys(store);
      if(keys.length>40){
        keys.sort((a,b)=>(store[b]?.ts||0)-(store[a]?.ts||0));
        const trimmed={};
        keys.slice(0,40).forEach(k=>{trimmed[k]=store[k];});
        localStorage.setItem(FOOD_SEARCH_CACHE_KEY,JSON.stringify(trimmed));
        return;
      }
      localStorage.setItem(FOOD_SEARCH_CACHE_KEY,JSON.stringify(store));
    }catch(e){}
  };

  const searchFood=async(q)=>{
    const normalized=String(q||"")
      .trim()
      .toLowerCase()
      .replace(/\bdal\s+chawal\b/g,"dal rice")
      .replace(/\blentils?\s+rice\b/g,"dal rice")
      .replace(/\s+/g," ");
    if(!normalized){
      setSearchResults([]);
      setSearchAllResults([]);
      setSearchSections({best:[],local:[],related:[]});
      setSearchDone(false);
      setSearchLoading(false);
      setSearchOffset(0);
      setSearchHasMore(false);
      setExpandedSearchId(null);
      return;
    }

    const locale=resolveSearchLocale();
    const cacheKey=`${normalized}|${locale.country||""}|${locale.state||""}`;
    
    // Cache check
    if(FOOD_SEARCH_CACHE.has(cacheKey)){
      const allRows=FOOD_SEARCH_CACHE.get(cacheKey);
      setSearchLastQuery(normalized);
      setSearchLastLocale(locale);
      setSearchOffset(searchDisplayLimit);
      const displayed=allRows.slice(0,searchDisplayLimit);
      setSearchAllResults(displayed);
      setSearchResults(displayed);
      setSearchSections(bucketSearchSections(displayed));
      setSearchHasMore(allRows.length>=searchDisplayLimit);
      setSearchDone(true);
      setSearchLoading(false);
      return;
    }

    const localRows=readLocalSearchCache(cacheKey);
    if(localRows){
      FOOD_SEARCH_CACHE.set(cacheKey,localRows);
      setSearchLastQuery(normalized);
      setSearchLastLocale(locale);
      setSearchOffset(searchDisplayLimit);
      const displayed=localRows.slice(0,searchDisplayLimit);
      setSearchAllResults(displayed);
      setSearchResults(displayed);
      setSearchSections(bucketSearchSections(displayed));
      setSearchHasMore(localRows.length>=searchDisplayLimit);
      setSearchDone(true);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);setSearchDone(false);setRes(null);
    try{
      const rows=await supa.rpc(user?.token,"search_foods_paginated",{
        p_query:normalized,
        p_limit:searchDisplayLimit,
        p_offset:0,
        p_user_country:locale.country||null,
        p_user_state:locale.state||null,
      });
      const mapped=mapFoodRows(rows);
      FOOD_SEARCH_CACHE.set(cacheKey,mapped);
      writeLocalSearchCache(cacheKey,mapped);
      setSearchAllResults(mapped);
      setSearchLastQuery(normalized);
      setSearchLastLocale(locale);
      setSearchOffset(mapped.length);
      setSearchResults(mapped);
      setSearchSections(bucketSearchSections(mapped));
      setSearchHasMore(mapped.length>=searchDisplayLimit);
      setSearchDone(true);
    }catch(e){
      console.error("RPC search_foods_paginated failed, falling back to search_foods:",e);
      try{
        const rows=await supa.rpc(user?.token,"search_foods",{
          p_query:normalized,
          p_limit:searchDisplayLimit,
          p_user_country:locale.country||null,
          p_user_state:locale.state||null,
        });
        const mapped=mapFoodRows(rows);
        FOOD_SEARCH_CACHE.set(cacheKey,mapped);
        writeLocalSearchCache(cacheKey,mapped);
        setSearchAllResults(mapped);
        setSearchLastQuery(normalized);
        setSearchLastLocale(locale);
        setSearchOffset(mapped.length);
        setSearchResults(mapped);
        setSearchSections(bucketSearchSections(mapped));
        setSearchHasMore(mapped.length>=searchDisplayLimit);
        setSearchDone(true);
      }catch(e2){
        toast("Search failed. Check connection.","❌");
      }
    }
    setSearchLoading(false);
  };

  // Load more search results
  const loadMoreSearchResults=async()=>{
    if(searchLoadingMore||!searchHasMore||!searchLastQuery)return;
    
    setSearchLoadingMore(true);
    try{
      const newOffset=searchOffset;
      const rows=await supa.rpc(user?.token,"search_foods_paginated",{
        p_query:searchLastQuery,
        p_limit:searchDisplayLimit,
        p_offset:newOffset,
        p_user_country:searchLastLocale?.country||null,
        p_user_state:searchLastLocale?.state||null,
      });
      
      const mapped=mapFoodRows(rows);
      const updated=[...searchAllResults,...mapped];
      setSearchAllResults(updated);
      setSearchOffset(newOffset+mapped.length);
      setSearchResults(updated);
      setSearchSections(bucketSearchSections(updated));
      setSearchHasMore(mapped.length>=searchDisplayLimit);
    }catch(e){
      console.error("Load more failed:",e);
      toast("Couldn't load more foods right now.","⚠️");
    }
    setSearchLoadingMore(false);
  };

  // Debounced search (400ms)
  const searchTimer=useRef(null);
  const onSearchChange=v=>{
    setSearchQ(v);
    clearTimeout(searchTimer.current);
    if(v.trim().length>1){
      setSearchLoading(true);
      searchTimer.current=setTimeout(()=>searchFood(v),400);
    }else{
      setSearchResults([]);
      setSearchAllResults([]);
      setSearchSections({best:[],local:[],related:[]});
      setSearchDone(false);
      setSearchLoading(false);
      setSearchOffset(0);
      setSearchHasMore(false);
      setExpandedSearchId(null);
    }
  };

  // ── Barcode lookup ──
  const openRearCameraStream=async()=>{
    if(!navigator?.mediaDevices?.getUserMedia)throw new Error("Camera not supported on this device.");
    const baseVideo={width:{ideal:960,max:1280},height:{ideal:540,max:720},frameRate:{ideal:20,max:24}};
    let stream;
    try{
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{exact:"environment"},...baseVideo}});
    }catch(e){
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},...baseVideo}});
    }
    const track=stream?.getVideoTracks?.()[0];
    if(track?.applyConstraints){
      await track.applyConstraints({frameRate:{ideal:20,max:24}}).catch(()=>{});
    }
    return stream;
  };

  const lookupBarcode=async(code)=>{
    const normalizedCode=String(code||"").replace(/[^\da-z]/gi,"").trim();
    if(!normalizedCode||normalizedCode.length<8){toast("Enter a valid barcode.","❌");return;}
    if(barcodeLoading)return;
    setBarcodeLoading(true);setRes(null);
    const setProductResult=(p)=>{
      const n=p?.nutriments||{};
      const serving=parseFloat(p?.serving_size)||100;
      const f=serving/100;
      setRes({name:p?.product_name||"Unknown Product",emoji:"📦",
        cal:Math.round((n["energy-kcal_100g"]||n["energy-kcal"]||0)*f),
        p:Math.round((n.proteins_100g||0)*f*10)/10,
        c:Math.round((n.carbohydrates_100g||0)*f*10)/10,
        f:Math.round((n.fat_100g||0)*f*10)/10,
        conf:100,source:"barcode",
        items:[`${p?.product_name||""}`,`Serving: ${p?.serving_size||"100g"}`,p?.brands?`Brand: ${p.brands}`:""].filter(Boolean),
      });
      setBarcodeStatus("found");
    };

    try{
      if(user?.token){
        try{
          const data=await supa.openFood(user.token,{action:"product",code:normalizedCode});
          if(data?.status===1&&data?.product){
            setProductResult(data.product);
            setBarcodeLoading(false);
            return;
          }
        }catch(_){/* fall through to public API */}
      }

      const r=await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(normalizedCode)}.json`);
      const data=await r.json();
      if(data?.status===1&&data?.product){
        setProductResult(data.product);
      }else{
        toast("Product not found. Try searching by name.","❌");
        setBarcodeStatus("idle");
      }
    }catch(_){
      toast("Network error.","❌");
      setBarcodeStatus("idle");
    }
    setBarcodeLoading(false);
  };

  const submitManualBarcode=()=>{
    const code=String(barcodeInput||"").replace(/\s+/g,"").trim();
    if(!code){toast("Enter a barcode first.","❌");return;}
    stopBarcodeCam();
    setBarcodeStatus("idle");
    lookupBarcode(code);
  };

  const requestCameraPermission=async()=>{
    if(!isNativeApp())return true;
    try{
      const result=await Camera.checkPermissions();
      if(result.camera==="granted")return true;
      const req=await Camera.requestPermissions({permissions:["camera"]});
      if(req.camera==="granted")return true;
      setCamErr("Camera permission denied. Please enable it in app settings.");
      return false;
    }catch(e){
      return true;
    }
  };

  const startBarcodeCam=async()=>{
    const reqId=++barcodeStartRef.current;
    if(barcodeOpenTimeoutRef.current){clearTimeout(barcodeOpenTimeoutRef.current);barcodeOpenTimeoutRef.current=null;}
    setCamErr("");setBarcodeStatus("loading");setRes(null);
    barcodeOpenTimeoutRef.current=setTimeout(()=>{
      setBarcodeStatus(s=>{
        if(s!=="loading")return s;
        setCamErr("Camera took too long to open. Enter barcode manually.");
        return "manual-barcode";
      });
    },8000);
    try{
      if(isNativeApp()){
        const perm=await requestCameraPermission();
        if(!perm){
          if(barcodeOpenTimeoutRef.current){clearTimeout(barcodeOpenTimeoutRef.current);barcodeOpenTimeoutRef.current=null;}
          setBarcodeStatus("idle");
          return;
        }
        const host=await waitForBarcodePreviewHost();
        if(!host)throw new Error("Preview container not ready");
        const rect=host.getBoundingClientRect();
        try{await CameraPreview.stop();}catch(e){}
        await CameraPreview.start({
          parent:"barcode-preview-host",
          className:"barcode-native-preview",
          position:"rear",
          x:Math.max(0,Math.round(rect.left)),
          y:Math.max(0,Math.round(rect.top)),
          width:Math.max(1,Math.round(rect.width)),
          height:Math.max(1,Math.round(rect.height)),
          toBack:false,
          enableZoom:true,
          disableAudio:true,
          storeToFile:false,
        });
        nativeBarcodePreviewRef.current=true;
        if(reqId!==barcodeStartRef.current){await stopNativeBarcodePreview();return;}
        if(barcodeOpenTimeoutRef.current){clearTimeout(barcodeOpenTimeoutRef.current);barcodeOpenTimeoutRef.current=null;}
        setBarcodeStatus("scanning");

        if(!("BarcodeDetector" in window)){
          setCamErr("Auto-scan not supported on this device. Enter barcode manually.");
          await stopNativeBarcodePreview();
          setBarcodeStatus("manual-barcode");
          return;
        }
        const detector=new window.BarcodeDetector({formats:barcodeFormats});
        nativeBarcodeScanTimerRef.current=setInterval(async()=>{
          if(nativeBarcodeScanBusyRef.current)return;
          if(barcodeStatusRef.current!=="scanning")return;
          nativeBarcodeScanBusyRef.current=true;
          try{
            const frame=await CameraPreview.capture({quality:40});
            const dataUrl=readNativeCaptureDataUrl(frame);
            const code=await detectBarcodeFromDataUrl(dataUrl,detector);
            if(code){
              clearInterval(nativeBarcodeScanTimerRef.current);
              nativeBarcodeScanTimerRef.current=null;
              await stopNativeBarcodePreview();
              await lookupBarcode(code);
            }
          }catch(e){}
          nativeBarcodeScanBusyRef.current=false;
        },650);
        setTimeout(()=>{setBarcodeStatus(s=>{if(s==="scanning"){stopNativeBarcodePreview();return"manual-barcode";}return s;});},25000);
        return;
      }

      // Use web-based barcode detection (native ML Kit barcode scanner disabled due to Android compilation issues)
      if(true){ // Temporarily disable native, use web fallback always
        // Fallback to web-based barcode detection
        const perm=await requestCameraPermission();
        if(!perm){
          if(barcodeOpenTimeoutRef.current){clearTimeout(barcodeOpenTimeoutRef.current);barcodeOpenTimeoutRef.current=null;}
          setBarcodeStatus("idle");
          return;
        }
        const stream=await openRearCameraStream();
        if(reqId!==barcodeStartRef.current){
          stream.getTracks().forEach(t=>t.stop());
          return;
        }
        streamRef.current=stream;
        if(videoRef.current){
          videoRef.current.srcObject=stream;
          try{await videoRef.current.play();}catch(e){}
        }
        if(reqId!==barcodeStartRef.current){
          stopBarcodeCam();
          return;
        }
        if(barcodeOpenTimeoutRef.current){clearTimeout(barcodeOpenTimeoutRef.current);barcodeOpenTimeoutRef.current=null;}
        setBarcodeStatus("scanning");
        if("BarcodeDetector" in window){
          const detector=new window.BarcodeDetector({formats:["ean_13","ean_8","upc_a","upc_e","code_128","code_39","qr_code"]});
          intervalRef.current=setInterval(async()=>{
            if(!videoRef.current)return;
            try{const codes=await detector.detect(videoRef.current);
              if(codes.length>0){clearInterval(intervalRef.current);stopBarcodeCam();await lookupBarcode(codes[0].rawValue);}
            }catch(e){}
          },500);
          setTimeout(()=>{clearInterval(intervalRef.current);setBarcodeStatus(s=>{if(s==="scanning"){stopBarcodeCam();return"manual-barcode";}return s;});},25000);
        }else{stopBarcodeCam();setBarcodeStatus("manual-barcode");}
      }
    }catch(e){
      if(barcodeOpenTimeoutRef.current){clearTimeout(barcodeOpenTimeoutRef.current);barcodeOpenTimeoutRef.current=null;}
      logAppError(e,"scanner.barcode_start");
      setCamErr("Barcode scanning failed. Try manual entry.");setBarcodeStatus("manual-barcode");
    }
  };

  const stopBarcodeCam=()=>{
    barcodeStartRef.current+=1;
    if(barcodeOpenTimeoutRef.current){clearTimeout(barcodeOpenTimeoutRef.current);barcodeOpenTimeoutRef.current=null;}
    clearInterval(intervalRef.current);
    if(streamRef.current){streamRef.current.getTracks().forEach(t=>t.stop());streamRef.current=null;}
    if(videoRef.current)videoRef.current.srcObject=null;
    stopNativeBarcodePreview();
  };

  // ── AI Camera scan ──
  const startAiCamera=async()=>{
    if(aiScanStartRef.current)return; // Prevent double-start
    aiScanStartRef.current=true;
    setAiScanStatus("loading");
    try{
      const perm=await requestCameraPermission();
      if(!perm){aiScanStartRef.current=null;setAiScanStatus("idle");return;}
      const stream=await openRearCameraStream();
      streamAiRef.current=stream;
      if(videoAiRef.current){videoAiRef.current.srcObject=stream;videoAiRef.current.play();}
      setAiScanStatus("scanning");
      aiScanStartRef.current=null;
    }catch(e){
      logAppError(e,"scanner.ai_camera_open");
      try{
        const fallback=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:960,max:1280},height:{ideal:540,max:720},frameRate:{ideal:20,max:24}}});
        streamAiRef.current=fallback;
        if(videoAiRef.current){videoAiRef.current.srcObject=fallback;videoAiRef.current.play();}
        setAiScanStatus("scanning");
        toast("Camera opened (check your settings if quality is low)","ℹ️");
        aiScanStartRef.current=null;
      }catch(_){
        logAppError(_,"scanner.ai_camera_fallback_open");
        toast("Camera access denied. Please enable camera permissions in app settings.","❌");
        setAiScanStatus("idle");
        aiScanStartRef.current=null;
      }
    }
  };

  const stopAiCamera=()=>{
    if(streamAiRef.current){streamAiRef.current.getTracks().forEach(t=>t.stop());streamAiRef.current=null;}
    if(videoAiRef.current)videoAiRef.current.srcObject=null;
    setAiScanStatus("idle");setScan(false);
    aiScanStartRef.current=null;
  };

  const doAiScan=async()=>{
    if(!videoAiRef.current||!canvasRef.current)return;
    if(!user?.token){toast("Sign in to use AI scan.","❌");return;}
    setScan(true);setAiScanStatus("scanning");setRes(null);
    try{
      const canvas=canvasRef.current;
      canvas.width=videoAiRef.current.videoWidth||640;
      canvas.height=videoAiRef.current.videoHeight||480;
      canvas.getContext("2d").drawImage(videoAiRef.current,0,0);
      const base64=canvas.toDataURL("image/jpeg",0.8).split(",")[1];
      const sys="You are a food recognition AI. Analyze the image and identify the food. Respond ONLY with valid JSON in this exact format: {\"name\":\"Food Name\",\"cal\":number,\"p\":number,\"c\":number,\"f\":number,\"emoji\":\"emoji\",\"items\":[\"ingredient 1\",\"ingredient 2\"]} where cal=calories, p=protein(g), c=carbs(g), f=fat(g). Estimate for a standard serving. No extra text.";
      const msgs=[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/jpeg",data:base64}},{type:"text",text:"What food is this? Give me the nutrition info as JSON."}]}];
      const data=await aiComplete(user.token,msgs,sys);
      const text=data.content?.[0]?.text||"";
      const match=text.match(/\{[\s\S]*\}/);
      if(match){
        const parsed=JSON.parse(match[0]);
        setRes({...parsed,conf:88,source:"ai"});
      }else{
        // Fallback: parse text response
        toast("AI couldn't identify this image. Try clearer lighting or manual entry.","❌");
      }
    }catch(e){
      logAppError(e,"scanner.ai_scan");
      toast(e?.message||"AI scan failed. Try again.","❌");
    }
    setScan(false);
  };

  // Cleanup on tab change
  useEffect(()=>{
    return()=>{stopBarcodeCam();stopAiCamera();};
  },[]);
  useEffect(()=>{
    if(mode!=="barcode")stopBarcodeCam();
    if(mode!=="camera"){stopAiCamera();}
    setRes(null);
  },[mode]);

  useEffect(()=>{
    if(mode==="barcode"&&online&&barcodeStatus==="idle"&&!res){
      startBarcodeCam();
    }
  },[barcodeStatus,mode,online,res]);

  const addLog=(food)=>{
    const f=food||res;if(!f)return;
    onAddMeal({...f,cal:Math.round(f.cal*part),p:Math.round((f.p||0)*part),c:Math.round((f.c||0)*part),f:Math.round((f.f||0)*part),m:mealType,t:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),id:Date.now(),e:f.emoji||"🍽️"});
    playSfx&&playSfx("success");
    toast(`${f.name} added to ${mealType}!`,"✅");
    setAdded(true);setTimeout(()=>{setAdded(false);setRes(null);setPart(1);},2000);
  };

  const submitManual=()=>{
    if(!manual.name.trim()){setManualErr("Food name is required");return;}
    if(!manual.cal||isNaN(+manual.cal)||+manual.cal<=0){setManualErr("Enter valid calories");return;}
    setManualErr("");
    setRes({name:manual.name.trim(),emoji:manual.e,cal:+manual.cal,p:+(manual.p)||0,c:+(manual.c)||0,f:+(manual.f)||0,conf:100,source:"manual",items:[manual.name.trim()]});
  };

  const getSearchPortion=(foodId)=>Math.max(0.25,Math.min(3,Number(searchPortions?.[foodId]||1)));
  const getSearchMealType=(foodId)=>searchMeals?.[foodId]||mealType||"Lunch";

  const addSearchFood=(food)=>{
    if(!food)return;
    const portion=getSearchPortion(food.id);
    const targetMeal=getSearchMealType(food.id);
    onAddMeal({
      ...food,
      cal:Math.round((food.cal||0)*portion),
      p:Math.round(((food.p||0)*portion)*10)/10,
      c:Math.round(((food.c||0)*portion)*10)/10,
      f:Math.round(((food.f||0)*portion)*10)/10,
      m:targetMeal,
      t:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),
      id:Date.now(),
      e:food.emoji||"🍽️"
    });
    playSfx&&playSfx("success");
    toast(`${food.name} added to ${targetMeal}!`,"✅");
    setSearchAddedId(food.id);
    setTimeout(()=>setSearchAddedId(null),280);
  };

  const SearchFoodRow=({food,icon="🍽️",chipBg=T.lavBg})=>{
    const expanded=expandedSearchId===food.id;
    const justAdded=searchAddedId===food.id;
    const portion=getSearchPortion(food.id);
    const selectedMeal=getSearchMealType(food.id);
    const kcal=Math.round((food.cal||0)*portion);
    const protein=Math.round(((food.p||0)*portion)*10)/10;

    return <div className="hover-card" style={{background:T.white,borderRadius:16,padding:"12px 14px",boxShadow:`0 2px 10px ${T.shadow}`,border:`2px solid ${expanded?T.purple:"transparent"}`}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:44,height:44,borderRadius:12,background:chipBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>{icon}</div>
        <div style={{flex:1,minWidth:0}}>
          <p style={{fontWeight:700,fontSize:13,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{food.name}</p>
          <p style={{fontSize:11,color:T.light,marginTop:2}}>{food.category} · {food.country}</p>
          <div style={{display:"flex",gap:10,marginTop:4,flexWrap:"wrap"}}>
            <span style={{fontSize:11,fontWeight:700,color:T.purple}}>{kcal} kcal</span>
            <span style={{fontSize:11,color:T.light}}>Protein: {protein}g</span>
          </div>
        </div>
        <button
          onClick={()=>{
            if(expanded){setExpandedSearchId(null);return;}
            setExpandedSearchId(food.id);
            setSearchPortions(prev=>prev?.[food.id]?prev:{...prev,[food.id]:1});
            setSearchMeals(prev=>prev?.[food.id]?prev:{...prev,[food.id]:mealType||"Lunch"});
          }}
          style={{
            width:36,
            height:36,
            borderRadius:12,
            border:`2px solid ${expanded?T.purple:T.border}`,
            background:expanded?T.purple:T.white,
            color:expanded?T.white:T.purple,
            fontSize:22,
            fontWeight:900,
            lineHeight:1,
            cursor:"pointer",
            display:"flex",
            alignItems:"center",
            justifyContent:"center",
            flexShrink:0,
            transition:"all .2s ease",
            transform:expanded?"scale(1.04)":"scale(1)"
          }}
          aria-label={expanded?"Collapse details":"Expand details"}
        >{expanded?"−":"+"}</button>
      </div>

      {expanded&&<div className="aFadeIn" style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${T.border}`,animationDuration:".18s"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <p style={{fontSize:12,fontWeight:700,color:T.mid}}>Quantity</p>
          <p style={{fontSize:12,fontWeight:800,color:T.purple}}>{portion}× serving</p>
        </div>
        <input
          type="range"
          min="0.25"
          max="3"
          step="0.25"
          value={portion}
          onChange={e=>setSearchPortions(prev=>({...prev,[food.id]:parseFloat(e.target.value)}))}
          style={{width:"100%",accentColor:T.purple,marginBottom:10}}
        />
        <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
          {["Breakfast","Lunch","Snack","Dinner"].map(mt=><button key={mt} onClick={()=>setSearchMeals(prev=>({...prev,[food.id]:mt}))} style={{padding:"6px 12px",borderRadius:20,border:`2px solid ${selectedMeal===mt?T.purple:T.border}`,background:selectedMeal===mt?T.lavBg:T.white,color:selectedMeal===mt?T.purple:T.mid,fontFamily:"Nunito",fontWeight:700,fontSize:11,cursor:"pointer"}}>{mt}</button>)}
        </div>
        <button
          className="btn btn-primary"
          onClick={()=>addSearchFood(food)}
          style={{
            padding:"11px 14px",
            fontSize:13,
            borderRadius:12,
            transition:"all .2s ease",
            transform:justAdded?"scale(1.03)":"scale(1)",
            boxShadow:justAdded?`0 0 0 4px ${T.mintBg}`:"none",
            background:justAdded?T.green:undefined
          }}
        >
          {justAdded?"✓ Added":"+ Add "+portion+"× to "+selectedMeal}
        </button>
      </div>}
    </div>;
  };

  const ResultCard=({food})=>{
    const f=food||res;if(!f)return null;
    return <div className="card aPopIn" style={{marginTop:12,border:`2px solid ${T.lav}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:48,height:48,borderRadius:14,background:T.lavBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26}}>{f.emoji||"🍽️"}</div>
          <div style={{flex:1,minWidth:0}}><p style={{fontWeight:800,fontSize:14,lineHeight:1.3}}>{f.name}</p>
            <p style={{fontSize:11,color:f.source==="ai"?T.purple:f.source==="barcode"?T.green:T.mid,fontWeight:700,marginTop:2}}>
              {f.source==="ai"?"🤖 AI identified":f.source==="barcode"?"📦 Barcode scan":f.source==="manual"?"✏️ Manual entry":"🔍 Food database"}
            </p>
          </div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}><p style={{fontSize:26,fontWeight:900,color:T.purple}}>{Math.round(f.cal*part)}</p><p style={{fontSize:10,color:T.light}}>kcal</p></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
        {[{l:"Protein",v:Math.round((f.p||0)*part),c:T.blue,bg:T.lavBg},{l:"Carbs",v:Math.round((f.c||0)*part),c:T.green,bg:T.mintBg},{l:"Fat",v:Math.round((f.f||0)*part),c:"#F0A060",bg:T.peachBg}].map(m=><div key={m.l} style={{textAlign:"center",padding:10,borderRadius:12,background:m.bg}}><p style={{fontSize:16,fontWeight:900,color:m.c}}>{m.v}g</p><p style={{fontSize:10,fontWeight:600,color:T.light}}>{m.l}</p></div>)}
      </div>
      <div style={{background:T.bg,borderRadius:12,padding:"10px 14px",marginBottom:10}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><p style={{fontSize:12,fontWeight:700,color:T.mid}}>Portion</p><p style={{fontSize:12,fontWeight:800,color:T.purple}}>{part}× serving</p></div>
        <input type="range" min=".25" max="3" step=".25" value={part} onChange={e=>setPart(parseFloat(e.target.value))} style={{width:"100%",accentColor:T.purple}}/>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
        {["Breakfast","Lunch","Snack","Dinner"].map(mt=><button key={mt} onClick={()=>setMealType(mt)} style={{padding:"6px 12px",borderRadius:20,border:`2px solid ${mealType===mt?T.purple:T.border}`,background:mealType===mt?T.lavBg:T.white,color:mealType===mt?T.purple:T.mid,fontFamily:"Nunito",fontWeight:700,fontSize:11,cursor:"pointer",transition:"all .15s"}}>{mt}</button>)}
      </div>
      {added?<div style={{padding:12,borderRadius:12,background:T.mintBg,textAlign:"center"}}><span style={{fontWeight:800,color:T.green}}>✓ Added to {mealType}!</span></div>
        :<button className="btn btn-primary" onClick={()=>addLog(f)}>+ Add to {mealType}</button>}
    </div>;
  };

  return <div style={{paddingBottom:110}}><SBar/>
    <div style={{padding:"4px 16px 20px",maxWidth:600,margin:"0 auto",width:"100%"}}>
      {!online&&<div className="card" style={{marginBottom:12,background:T.peachBg,padding:12}}><p style={{fontSize:13,fontWeight:700,lineHeight:1.45}}>📡 Offline — only ✏️ Manual works. Entries are saved and sync to Supabase when you&apos;re online.</p></div>}
      <div className="scan-hero">
        <div><h2 style={{fontSize:24,fontWeight:900,letterSpacing:-.2}}>Food Scanner</h2><p style={{fontSize:13,color:T.light,fontWeight:600}}>Search, scan or enter manually</p></div>
        <div className="scan-live-pill"><div style={{width:6,height:6,borderRadius:"50%",background:T.green,boxShadow:`0 0 10px ${T.green}`}}/><span style={{fontSize:11,fontWeight:800,color:T.green}}>Live DB</span></div>
      </div>

      {/* Mode tabs */}
      <div className="scan-mode-wrap">
        {[{id:"search",l:"🔍 Search"},{id:"barcode",l:"📦 Barcode"},{id:"camera",l:"📸 AI Scan"},{id:"manual",l:"✏️ Manual"}].map(m=>(
          <button key={m.id} onClick={()=>setModeSafe(m.id)} className={`scan-mode-btn ${mode===m.id?"on":"off"}`} style={{opacity:!online&&m.id!=="manual"?0.45:1}}>{m.l}{!online&&m.id!=="manual"?" (offline)":""}</button>
        ))}
      </div>

      {/* ── SEARCH MODE ── */}
      {mode==="search"&&<div className="aFadeIn">
        {/* Search input */}
        <div style={{position:"relative",marginBottom:12}}>
          <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",color:T.light}}>{Ic.search}</span>
          <input className="inp inp-padl" placeholder="Search foods, brands, meals…" value={searchQ} onChange={e=>onSearchChange(e.target.value)} style={{background:T.white}}/>
          {searchQ&&<button onClick={()=>{setSearchQ("");setSearchResults([]);setSearchAllResults([]);setSearchSections({best:[],local:[],related:[]});setSearchDone(false);setSearchOffset(0);setSearchHasMore(false);setExpandedSearchId(null);}} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:T.light,fontSize:18}}>×</button>}
        </div>

        {/* Quick food chips */}
        {!searchQ&&<div style={{marginBottom:16}}>
          <p style={{fontSize:12,fontWeight:700,color:T.mid,marginBottom:8,textTransform:"uppercase",letterSpacing:.8}}>Quick Search</p>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {["Dal Rice","Roti","Idli","Chicken","Paneer","Oats","Egg","Banana","Milk","Curd"].map(q=>(
              <button key={q} onClick={()=>{setSearchQ(q);searchFood(q);}} style={{padding:"7px 14px",borderRadius:20,background:T.lavBg,color:T.purple,border:"none",fontFamily:"Nunito",fontSize:12,fontWeight:700,cursor:"pointer"}}>{q}</button>
            ))}
          </div>
        </div>}

        {/* Loading */}
        {searchLoading&&<div style={{textAlign:"center",padding:"32px 0"}}><div className="aSpin" style={{width:32,height:32,border:`3px solid ${T.lav}`,borderTop:`3px solid ${T.purple}`,borderRadius:"50%",margin:"0 auto 12px"}}/><p style={{color:T.mid,fontWeight:600,fontSize:13}}>Searching food database…</p></div>}

        {/* Results */}
        {!searchLoading&&searchDone&&<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <p style={{fontSize:13,fontWeight:700,color:T.mid}}>{searchResults.length}/{searchAllResults.length} result{searchAllResults.length!==1?"s":""}</p>
          </div>
          {searchAllResults.length===0&&<div style={{textAlign:"center",padding:"40px 0",color:T.light}}><div style={{fontSize:48,marginBottom:12}}>🔍</div><p style={{fontWeight:600,fontSize:14}}>No foods found</p><p style={{fontSize:12,marginTop:4}}>Try another food name</p></div>}

          {searchSections.best.length>0&&<div style={{marginBottom:12}}>
            <p style={{fontSize:12,fontWeight:800,color:T.mid,letterSpacing:.6,textTransform:"uppercase",marginBottom:8}}>Best Match</p>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {searchSections.best.map((food,i)=><SearchFoodRow key={food.id||i} food={food} icon="🍽️" chipBg={T.lavBg}/>) }
            </div>
          </div>}

          {searchSections.local.length>0&&<div style={{marginBottom:12}}>
            <p style={{fontSize:12,fontWeight:800,color:T.mid,letterSpacing:.6,textTransform:"uppercase",marginBottom:8}}>Local Foods</p>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {searchSections.local.map((food,i)=><SearchFoodRow key={food.id||i} food={food} icon="📍" chipBg={T.mintBg}/>) }
            </div>
          </div>}

          {searchSections.related.length>0&&<div style={{marginBottom:6}}>
            <p style={{fontSize:12,fontWeight:800,color:T.mid,letterSpacing:.6,textTransform:"uppercase",marginBottom:8}}>Related Foods</p>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {searchSections.related.map((food,i)=><SearchFoodRow key={food.id||i} food={food} icon="🥗" chipBg={T.bg}/>) }
            </div>
          </div>}
          
          {/* Load More Button */}
          {searchResults.length>0&&searchHasMore&&<div style={{marginTop:20,marginBottom:20,textAlign:"center"}}>
            <button onClick={loadMoreSearchResults} disabled={searchLoadingMore} style={{background:searchLoadingMore?T.light:T.purple,color:"white",border:"none",borderRadius:12,padding:"12px 24px",fontWeight:700,fontSize:13,cursor:searchLoadingMore?"not-allowed":"pointer",opacity:searchLoadingMore?0.6:1,transition:"all 0.2s"}}>
              {searchLoadingMore?"Loading...":"Load More"}
            </button>
          </div>}
        </>}
      </div>}

      {/* ── BARCODE MODE ── */}
      {mode==="barcode"&&<div className="aFadeIn">
        {barcodeStatus==="idle"&&!res&&<div className="card scan-shell scan-idle-dark" style={{textAlign:"center",padding:"30px 20px",marginBottom:16}}>
          <span className="scan-idle-icon">📦</span>
          <p style={{fontWeight:800,fontSize:17,marginBottom:6}}>Barcode Scanner</p>
          <p className="scan-idle-sub" style={{fontSize:13,fontWeight:600,marginBottom:16}}>Scan any product barcode to get real nutrition info from the global food database</p>
          {camErr&&<p style={{fontSize:13,color:T.red,fontWeight:600,marginBottom:12}}>{camErr}</p>}
          <button className="btn btn-primary" style={{marginBottom:12}} onClick={startBarcodeCam}>📷 Open Camera</button>
          <p className="scan-idle-sub" style={{fontSize:12,marginBottom:8}}>or enter barcode manually</p>
          <div style={{display:"flex",gap:8}}>
            <input className="inp" inputMode="numeric" enterKeyHint="search" autoCapitalize="off" autoCorrect="off" placeholder="e.g. 8901234567890" value={barcodeInput} onChange={e=>setBarcodeInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submitManualBarcode()}/>
            <button className="btn-soft" onClick={submitManualBarcode} disabled={barcodeLoading}>Lookup</button>
          </div>
        </div>}

        {barcodeStatus==="loading"&&<div className="card scan-shell" style={{marginBottom:16}}>
          <div className="camera-frame">
            {isNativeApp()
              ?<div id="barcode-preview-host" style={{position:"absolute",inset:0,zIndex:1,background:"#000"}}/>
              :<div style={{position:"absolute",inset:0,zIndex:1,background:"#000"}}/>}
            <div style={{position:"absolute",inset:0,zIndex:2,background:"rgba(0,0,0,.42)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
              <div className="aSpin" style={{width:34,height:34,border:`3px solid ${T.lav}`,borderTop:`3px solid ${T.purple}`,borderRadius:"50%",margin:"0 auto 12px"}}/>
              <p style={{fontSize:14,fontWeight:800,color:"white",marginBottom:4}}>Opening camera...</p>
              <p style={{fontSize:12,color:"rgba(255,255,255,.8)",fontWeight:600}}>This can take 3–4 seconds on some phones</p>
            </div>
          </div>
          <button className="btn btn-ghost" onClick={()=>{stopBarcodeCam();setBarcodeStatus("idle");}}>Cancel</button>
        </div>}

        {barcodeStatus==="scanning"&&<div className="card scan-shell" style={{marginBottom:16}}>
          <div className="camera-frame">
            {isNativeApp()
              ?<div id="barcode-preview-host" style={{position:"absolute",inset:0,zIndex:1,background:"#000"}}/>
              :<video ref={videoRef} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",zIndex:1}} playsInline muted autoPlay/>}
            <div className="scan-line"/>
            <div className="scan-hud">
              <div style={{width:8,height:8,borderRadius:"50%",background:T.lav,animation:"blink 1s ease-in-out infinite"}}/>
              <span style={{fontSize:12,color:"white",fontWeight:600}}>Scanning for barcode…</span>
            </div>
          </div>
          <button className="btn btn-ghost" onClick={()=>{stopBarcodeCam();setBarcodeStatus("idle");}}>Cancel</button>
        </div>}

        {barcodeStatus==="manual-barcode"&&<div className="card scan-shell" style={{marginBottom:16}}>
          <p style={{fontWeight:700,fontSize:13,marginBottom:8,color:T.mid}}>Auto-scan not supported. Enter barcode manually:</p>
          <div style={{display:"flex",gap:8,marginBottom:10}}>
            <input className="inp" inputMode="numeric" enterKeyHint="search" autoCapitalize="off" autoCorrect="off" placeholder="e.g. 8901234567890" value={barcodeInput} onChange={e=>setBarcodeInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submitManualBarcode()} style={{flex:1}}/>
            <button className="btn-soft" onClick={submitManualBarcode} disabled={barcodeLoading}>Lookup</button>
          </div>
          <button className="btn btn-ghost" onClick={()=>{stopBarcodeCam();setBarcodeStatus("idle");}}>Cancel</button>
        </div>}

        {barcodeLoading&&<div className="card scan-shell" style={{textAlign:"center",padding:"24px"}}>
          <div className="aSpin" style={{width:36,height:36,border:`3px solid ${T.lav}`,borderTop:`3px solid ${T.purple}`,borderRadius:"50%",margin:"0 auto 12px"}}/>
          <p style={{fontWeight:700,color:T.mid}}>Looking up product…</p>
        </div>}

        {barcodeStatus==="found"&&res&&<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <p style={{fontSize:13,fontWeight:700,color:T.green}}>✓ Product found!</p>
            <button className="btn-soft" onClick={()=>{setRes(null);setBarcodeStatus("idle");setBarcodeInput("");}}>Scan Another</button>
          </div>
          <ResultCard/>
        </>}
      </div>}

      {/* ── AI CAMERA MODE ── */}
      {mode==="camera"&&<div className="aFadeIn">
        {aiScanStatus==="idle"&&!res&&<div className="card scan-shell scan-idle-dark" style={{textAlign:"center",padding:"30px 20px",marginBottom:16}}>
          <span className="scan-idle-icon">🤖</span>
          <p style={{fontWeight:800,fontSize:18,marginBottom:6}}>Scan food with AI</p>
          <p className="scan-idle-sub" style={{fontSize:13,fontWeight:600,marginBottom:16}}>Open your camera to start scanning</p>
          {camErr&&<p style={{fontSize:13,color:T.red,fontWeight:600,marginBottom:12}}>{camErr}</p>}
          <button className="btn btn-primary" style={{marginBottom:2}} onClick={startAiCamera}>Open Camera</button>
        </div>}

        {aiScanStatus==="loading"&&<div className="card scan-shell" style={{marginBottom:16}}>
          <div className="camera-frame">
            <div style={{position:"absolute",inset:0,zIndex:2,background:"rgba(0,0,0,.42)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
              <div className="aSpin" style={{width:34,height:34,border:`3px solid ${T.lav}`,borderTop:`3px solid ${T.purple}`,borderRadius:"50%",margin:"0 auto 12px"}}/>
              <p style={{fontSize:14,fontWeight:800,color:"white",marginBottom:4}}>Opening camera...</p>
              <p style={{fontSize:12,color:"rgba(255,255,255,.8)",fontWeight:600}}>This can take 3–4 seconds on some phones</p>
            </div>
          </div>
          <button className="btn btn-ghost" onClick={()=>{stopAiCamera();setAiScanStatus("idle");}}>Cancel</button>
        </div>}

        {aiScanStatus==="scanning"&&<div className="card scan-shell" style={{marginBottom:16}}>
          <div className="camera-frame">
            <video ref={videoAiRef} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",zIndex:1}} playsInline muted autoPlay/>
            {[[{top:"8%",left:"8%"},3,3,0,0],[{top:"8%",right:"8%"},3,0,3,0],[{bottom:"8%",left:"8%"},0,3,0,3],[{bottom:"8%",right:"8%"},0,0,3,3]].map(([pos,bt,bl,br,bb],i)=><div key={i} style={{position:"absolute",width:26,height:26,borderColor:"white",borderStyle:"solid",borderTopWidth:bt,borderLeftWidth:bl,borderRightWidth:br,borderBottomWidth:bb,...pos,zIndex:2,opacity:.7}}/>)}
            {scan&&<div className="scan-line"/>}
            <div className="scan-hud" style={{zIndex:3}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:T.lav,animation:"blink 1s ease-in-out infinite"}}/>
              <span style={{fontSize:12,color:"white",fontWeight:600}}>Analyzing food…</span>
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn btn-primary" onClick={doAiScan} disabled={scan} style={{flex:1}}>🤖 Scan</button>
            <button className="btn btn-ghost" onClick={stopAiCamera} style={{flex:1}}>Stop</button>
          </div>
        </div>}

        {aiScanStatus!=="idle"&&<div className="card scan-shell" style={{marginBottom:12}}>
          <p style={{fontSize:13,fontWeight:700,marginBottom:8}}>💡 Tips for best results</p>
          {["Hold camera 20–30cm from food","Good lighting helps accuracy","Works best with single dishes","Indian foods recognized well"].map(t=><p key={t} style={{fontSize:12,color:T.mid,marginBottom:4}}>• {t}</p>)}
        </div>}
        
        <canvas ref={canvasRef} style={{display:"none"}}/>
        {res&&<ResultCard/>}
      </div>}

      {/* ── MANUAL MODE ── */}
      {mode==="manual"&&<div className="aFadeIn">
        <div className="card" style={{marginBottom:16}}>
          <p style={{fontSize:15,fontWeight:800,marginBottom:14}}>Enter Food Details</p>
          <div style={{marginBottom:12}}>
            <label className="flabel">Pick Emoji</label>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,padding:"8px",background:T.bg,borderRadius:12}}>
              {EMOJIS.map(em=><button key={em} onClick={()=>setManual(p=>({...p,e:em}))} style={{width:34,height:34,borderRadius:9,border:`2px solid ${manual.e===em?T.purple:"transparent"}`,background:manual.e===em?T.lavBg:"transparent",fontSize:18,cursor:"pointer",transition:"all .15s"}}>{em}</button>)}
            </div>
          </div>
          <div style={{marginBottom:10}}><label className="flabel">Food Name *</label><input className="inp" placeholder="e.g. Dal Makhani" value={manual.name} onChange={e=>setManual(p=>({...p,name:e.target.value}))}/></div>
          <div style={{marginBottom:10}}><label className="flabel">Calories (kcal) *</label><input className="inp" type="number" placeholder="e.g. 350" value={manual.cal} onChange={e=>setManual(p=>({...p,cal:e.target.value}))}/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
            {[{k:"p",l:"Protein (g)"},{k:"c",l:"Carbs (g)"},{k:"f",l:"Fat (g)"}].map(({k,l})=><div key={k}><label className="flabel">{l}</label><input className="inp" type="number" placeholder="0" value={manual[k]} onChange={e=>setManual(p=>({...p,[k]:e.target.value}))} style={{textAlign:"center"}}/></div>)}
          </div>
          {manualErr&&<p className="ferr" style={{marginBottom:8}}>{manualErr}</p>}
          <button className="btn btn-primary" onClick={submitManual}>Preview Entry</button>
        </div>
        {res&&<ResultCard/>}
      </div>}
    </div>
  </div>;
}

/* ══════════════ ANALYTICS ══════════════ */
function Analytics({user}){
  const [tab,setTab]=useState("week");
  const [loading,setLoading]=useState(true);
  const [calByDate,setCalByDate]=useState(new Map());
  const [proteinByDate,setProteinByDate]=useState(new Map());
  const [weightChart,setWeightChart]=useState([]);
  const [weightMeta,setWeightMeta]=useState({start:null,now:null,delta:null});
  const [streak,setStreak]=useState(0);
  const [onTargetCount,setOnTargetCount]=useState(0);
  const bmr=fBMR(user.gender,+user.weight,+user.height,+user.age);
  const tdee=fTDEE(bmr,user.activity);
  const calTarget=fTarget(tdee,user.goal);

  useEffect(()=>{
    let cancel=false;
    (async()=>{
      const uid=user?.id,tok=user?.token;
      if(!uid||!tok){setLoading(false);return;}
      const today=ymdLocal(new Date());
      const start30=addDaysStr(today,-29);
      const b=fBMR(user.gender,+user.weight,+user.height,+user.age);
      const tgt=fTarget(fTDEE(b,user.activity),user.goal);
      try{
        const mealRows=await supa.select(tok,"meals","log_date,calories,protein",`&user_id=eq.${uid}&log_date=gte.${start30}&order=log_date.asc`);
        const map=new Map();
        const pMap=new Map();
        if(Array.isArray(mealRows)){
          for(const row of mealRows){
            const ld=row.log_date;
            map.set(ld,(map.get(ld)||0)+(+row.calories||0));
            pMap.set(ld,(pMap.get(ld)||0)+(+row.protein||0));
          }
        }
        const last7=dateRangeInclusive(today,7);
        let onT=0;
        for(const d of last7){
          const c=map.get(d)||0;
          if(c>=tgt*.95&&c<=tgt*1.05)onT++;
        }
        if(!cancel) setOnTargetCount(onT);

        const streakStart=addDaysStr(today,-120);
        const streakRows=await supa.select(tok,"meals","log_date",`&user_id=eq.${uid}&log_date=gte.${streakStart}&order=log_date.asc`);
        const ds=new Set();
        if(Array.isArray(streakRows)) streakRows.forEach(r=>ds.add(r.log_date));
        if(!cancel) setStreak(computeMealStreak(ds,today));

        let wChart=[];
        let meta={start:null,now:null,delta:null};
        try{
          const wl=await supa.select(tok,"weight_logs","logged_at,weight",`&user_id=eq.${uid}&logged_at=gte.${start30}&order=logged_at.asc`);
          if(Array.isArray(wl)&&wl.length){
            const wFirst=+wl[0].weight,wLast=+wl[wl.length-1].weight;
            meta={start:wFirst,now:wLast,delta:Math.round((wFirst-wLast)*10)/10};
            let carry=null;
            for(const d of dateRangeInclusive(today,30)){
              const row=wl.find(r=>r.logged_at===d);
              if(row!=null)carry=+row.weight;
              if(carry!=null)wChart.push({day:d.slice(5),w:carry});
            }
          }
        }catch(e){}
        if(wChart.length===0){
          try{
            const prof=await supa.select(tok,"profiles","weight",`&id=eq.${uid}`);
            const pw=Array.isArray(prof)&&prof[0]?.weight!=null?+prof[0].weight:null;
            if(pw!=null){
              wChart=dateRangeInclusive(today,30).map(d=>({day:d.slice(5),w:pw}));
              meta={start:pw,now:pw,delta:0};
            }
          }catch(e){}
        }
        if(!cancel){setWeightChart(wChart);setWeightMeta(meta);}
        if(!cancel){setCalByDate(map);setProteinByDate(pMap);}
      }catch(e){}
      if(!cancel) setLoading(false);
    })();
    return()=>{cancel=true;};
  },[user?.id,user?.token,user?.gender,user?.weight,user?.height,user?.age,user?.activity,user?.goal]);

  const todayStr=ymdLocal(new Date());
  const nDays=tab==="week"?7:tab==="2w"?14:30;
  const fmtChartDay=(d,n)=>{
    const dt=new Date(d+"T12:00:00");
    if(n<=7)return dt.toLocaleDateString("en-US",{weekday:"short"});
    return dt.toLocaleDateString("en-US",{month:"short",day:"numeric"});
  };
  const rangeDays=dateRangeInclusive(todayStr,nDays);
  const areaData=rangeDays.map(d=>({day:fmtChartDay(d,nDays),cal:calByDate.get(d)||0,target:calTarget}));
  const barData=dateRangeInclusive(todayStr,nDays).map(d=>({day:fmtChartDay(d,nDays),cal:calByDate.get(d)||0}));
  const avg=areaData.length?Math.round(areaData.reduce((a,d)=>a+d.cal,0)/areaData.length):0;
  const hasMealData=Array.from(calByDate.values()).some(c=>c>0);
  const yMin=Math.max(500,Math.floor(calTarget*0.5));
  const yMax=Math.max(calTarget+400,yMin+400);

  const CT=({active,payload,label})=>active&&payload?.length?<div style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:12,padding:"8px 12px",fontFamily:"Nunito",fontSize:12}}><p style={{color:T.light,marginBottom:4}}>{label||payload[0]?.payload?.day}</p>{payload.map(p=><p key={p.name} style={{color:p.color||T.purple,fontWeight:700}}>{typeof p.value==="number"?Math.round(p.value*10)/10:p.value} {p.name==="w"?"kg":"kcal"}</p>)}</div>:null;

  const wm=weightMeta;
  const insightCards=useMemo(()=>buildAnalyticsInsights({calByDate,proteinByDate,calTarget,streak,onTargetCount,weightMeta,goal:user?.goal}),[calByDate,proteinByDate,calTarget,streak,onTargetCount,weightMeta,user?.goal]);

  if(loading)return <div style={{paddingBottom:110}}><SBar/><div style={{minHeight:"calc(100vh - 180px)",display:"flex",alignItems:"center",justifyContent:"center",padding:"24px 16px",textAlign:"center"}}><div><div className="aSpin" style={{width:30,height:30,border:`2.5px solid ${T.lav}`,borderTop:`2.5px solid ${T.purple}`,borderRadius:"50%",margin:"0 auto 12px"}}/><p style={{color:T.mid,fontWeight:700,fontSize:14}}>Loading stats…</p></div></div></div>;

  return <div style={{paddingBottom:110}}><SBar/>
    <div style={{padding:"4px 16px 20px",maxWidth:600,margin:"0 auto",width:"100%"}}>
      <div style={{marginBottom:20}}><h2 style={{fontSize:24,fontWeight:900}}>Analytics</h2><p style={{fontSize:13,color:T.light,fontWeight:500}}>Your progress over time</p></div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        {["week","2w","month"].map(t=><button key={t} className={`tab-pill ${tab===t?"on":"off"}`} onClick={()=>setTab(t)}>{t==="week"?"Week":t==="2w"?"2 Weeks":"Month"}</button>)}
      </div>
      {!hasMealData&&<p style={{textAlign:"center",color:T.mid,fontWeight:700,marginBottom:16}}>No data yet — start logging meals!</p>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
        {[{l:"Avg Calories",v:`${avg}`,s:"in range",bg:T.pinkBg},{l:"On Target",v:`${onTargetCount}/7`,s:"last 7 days",bg:T.mintBg},{l:"Weight",v:wm.now!=null?`${wm.now} kg`:"—",s:wm.delta!=null?(wm.delta>=0?`Δ ${wm.delta} kg`:`Δ +${-wm.delta} kg`):"vs start",bg:T.lavBg},{l:"Streak",v:`${streak} 🔥`,s:"days",bg:T.peachBg}].map((s,i)=><div key={i} className="pcard" style={{background:s.bg,padding:"16px"}}><p style={{fontSize:10,fontWeight:700,color:T.mid,textTransform:"uppercase",letterSpacing:.9}}>{s.l}</p><p style={{fontSize:24,fontWeight:900,marginTop:4}}>{s.v}</p><p style={{fontSize:11,color:T.mid,fontWeight:500,marginTop:2}}>{s.s}</p></div>)}
      </div>
      <div className="card" style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}><p style={{fontSize:15,fontWeight:800}}>Calories vs Target</p><div style={{display:"flex",gap:12}}><div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:9,height:9,borderRadius:3,background:T.purple}}/><span style={{fontSize:11,color:T.light,fontWeight:600}}>Actual</span></div><div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:12,height:2,background:T.pink}}/><span style={{fontSize:11,color:T.light,fontWeight:600}}>Target</span></div></div></div>
        <ResponsiveContainer width="100%" height={175}><AreaChart data={areaData} margin={{top:5,right:5,bottom:0,left:-24}}><defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.lav} stopOpacity={.55}/><stop offset="100%" stopColor={T.lav} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis dataKey="day" tick={{fill:T.light,fontSize:11,fontFamily:"Nunito",fontWeight:600}}/><YAxis tick={{fill:T.light,fontSize:10,fontFamily:"Nunito"}} domain={[yMin,yMax]}/><Tooltip content={<CT/>}/><Area type="monotone" dataKey="cal" stroke={T.purple} fill="url(#cg)" strokeWidth={2.5} dot={false}/><Line type="monotone" dataKey="target" stroke={T.pink} strokeWidth={2} strokeDasharray="5 5" dot={false}/></AreaChart></ResponsiveContainer>
      </div>
      <div className="card" style={{marginBottom:14}}>
        <p style={{fontSize:15,fontWeight:800,marginBottom:16}}>Weight Progress</p>
        {weightChart.length===0
          ?<p style={{fontSize:13,color:T.light,fontWeight:600}}>Log weight from the dashboard to see your trend.</p>
          :<><ResponsiveContainer width="100%" height={155}><LineChart data={weightChart} margin={{top:5,right:5,bottom:0,left:-24}}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis dataKey="day" tick={{fill:T.light,fontSize:10,fontFamily:"Nunito"}} interval={4}/><YAxis tick={{fill:T.light,fontSize:10,fontFamily:"Nunito"}} domain={["auto","auto"]}/><Tooltip content={<CT/>}/><Line type="monotone" dataKey="w" stroke={T.mint} strokeWidth={2.5} dot={false}/></LineChart></ResponsiveContainer>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:12}}>{[{l:"Start",v:wm.start!=null?`${wm.start} kg`:"—",c:T.pink},{l:"Change",v:wm.delta!=null?(wm.delta===0?"0 kg":(wm.delta>0?`−${wm.delta} kg`:`+${-wm.delta} kg`)):"—",c:wm.delta==null?T.mid:(wm.delta>=0?T.green:T.orange)},{l:"Now",v:wm.now!=null?`${wm.now} kg`:"—",c:T.purple}].map(s=><div key={s.l} style={{textAlign:"center",padding:"10px 6px",background:T.bg,borderRadius:12}}><p style={{fontSize:11,color:T.light,fontWeight:600}}>{s.l}</p><p style={{fontSize:14,fontWeight:900,color:s.c,marginTop:2}}>{s.v}</p></div>)}</div></>}
      </div>
      <div className="card" style={{marginBottom:14}}>
        <p style={{fontSize:15,fontWeight:800,marginBottom:16}}>Daily calories{tab==="week"?" (last 7 days)":tab==="2w"?" (last 14 days)":" (last 30 days)"}</p>
        <ResponsiveContainer width="100%" height={tab==="month"?180:135}><BarChart data={barData} margin={{top:5,right:5,bottom:tab==="month"?8:0,left:-24}}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis dataKey="day" tick={{fill:T.light,fontSize:tab==="month"?9:11,fontFamily:"Nunito",fontWeight:600}} interval={tab==="month"?2:0} angle={tab==="month"?-35:0} textAnchor={tab==="month"?"end":"middle"} height={tab==="month"?48:30}/><YAxis tick={{fill:T.light,fontSize:10,fontFamily:"Nunito"}}/><Tooltip contentStyle={{background:T.white,border:`1px solid ${T.border}`,borderRadius:12,fontFamily:"Nunito"}}/><Bar dataKey="cal" fill={T.lav} radius={[6,6,0,0]}/></BarChart></ResponsiveContainer>
      </div>
      <div><p style={{fontSize:15,fontWeight:800,marginBottom:14}}>🤖 Insights</p>
        {insightCards.map((ins,i)=><div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",padding:"14px",borderRadius:16,marginBottom:10,background:ins.bg}}><div style={{width:38,height:38,borderRadius:12,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{ins.e}</div><p style={{fontSize:13,fontWeight:600,color:T.text,lineHeight:1.6}}>{ins.txt}</p></div>)}
      </div>
    </div>
  </div>;
}

/* ══════════════ ACHIEVEMENTS ══════════════ */
function Achievements({user,toast,inline=false}){
  const defs=buildAchievementDefs();
  const [loading,setLoading]=useState(true);
  const [streak,setStreak]=useState(0);
  const [earned,setEarned]=useState(new Set());
  const [calWeek,setCalWeek]=useState([]);

  useEffect(()=>{
    let cancel=false;
    (async()=>{
      const uid=user?.id,tok=user?.token;
      if(!uid||!tok){setLoading(false);return;}
      const today=ymdLocal(new Date());
      const start30=addDaysStr(today,-29);
      const b=fBMR(user.gender,+user.weight,+user.height,+user.age);
      const tgt=fTarget(fTDEE(b,user.activity),user.goal);
      const {tP,tC,tF}=macroTargets(tgt);
      try{
        const meals=await supa.select(tok,"meals","log_date,calories,protein,carbs,fat",`&user_id=eq.${uid}&log_date=gte.${start30}&order=log_date.asc`);
        const waterRows=await supa.select(tok,"water_logs","log_date,glasses",`&user_id=eq.${uid}&log_date=gte.${start30}&order=log_date.asc`);
        const achRows=await supa.select(tok,"achievements","achievement_id,earned_at",`&user_id=eq.${uid}`);
        const earnedNow=new Set(Array.isArray(achRows)?achRows.map(r=>r.achievement_id):[]);

        const byDay=new Map();
        if(Array.isArray(meals)){
          for(const m of meals){
            const d=m.log_date;
            if(!byDay.has(d))byDay.set(d,{cal:0,p:0,c:0,f:0});
            const o=byDay.get(d);
            o.cal+=+m.calories||0;o.p+=+m.protein||0;o.c+=+m.carbs||0;o.f+=+m.fat||0;
          }
        }
        const longStart=addDaysStr(today,-120);
        const streakRows=await supa.select(tok,"meals","log_date",`&user_id=eq.${uid}&log_date=gte.${longStart}`);
        const ds=new Set();
        if(Array.isArray(streakRows)) streakRows.forEach(r=>ds.add(r.log_date));
        const str=computeMealStreak(ds,today);
        if(!cancel) setStreak(str);

        const last7=dateRangeInclusive(today,7);
        let calorieHitDays=0;
        for(const d of last7){
          const c=byDay.get(d)?.cal||0;
          if(c>=tgt*.95&&c<=tgt*1.05)calorieHitDays++;
        }
        let macroHit=false;
        for(const [,v] of byDay){
          if(v.p>=tP&&v.c>=tC&&v.f>=tF){macroHit=true;break;}
        }
        const waterGoodDays=new Set();
        if(Array.isArray(waterRows)) waterRows.forEach(r=>{if((+r.glasses||0)>=8)waterGoodDays.add(r.log_date);});
        const hydrationOk=waterGoodDays.size>=7;

        const totalMeals=await supa.countExact(tok,"meals",`&user_id=eq.${uid}`);
        const unlocked=new Set(earnedNow);
        if(str>=7)unlocked.add(1);
        if(calorieHitDays>=5)unlocked.add(2);
        if(totalMeals>=21)unlocked.add(3);
        if(hydrationOk)unlocked.add(4);
        if(macroHit)unlocked.add(5);
        if(str>=30)unlocked.add(6);

        for(const aid of unlocked){
          if(!earnedNow.has(aid)){
            try{
              await supa.insert(tok,"achievements",{user_id:uid,achievement_id:aid});
            }catch(e){}
          }
        }
        const ach2=await supa.select(tok,"achievements","achievement_id,earned_at",`&user_id=eq.${uid}`);
        const finalEarned=new Set(Array.isArray(ach2)?ach2.map(r=>r.achievement_id):[]);
        const last7d=dateRangeInclusive(today,7);
        const weekCal=last7d.map(d=>({
          label:new Date(d+"T12:00:00").toLocaleDateString("en-US",{weekday:"narrow"}),
          ok:(byDay.get(d)?.cal||0)>0,
        }));
        if(!cancel){
          setEarned(finalEarned);
          setCalWeek(weekCal);
        }
      }catch(e){}
      if(!cancel) setLoading(false);
    })();
    return()=>{cancel=true;};
  },[user?.id,user?.token,user?.gender,user?.weight,user?.height,user?.age,user?.activity,user?.goal]);

  const total=defs.filter(d=>earned.has(d.id)).reduce((s,d)=>s+d.xp,0);
  const level=Math.floor(total/300)+1,inLevel=total%300;

  const inner=loading
    ?<div style={{textAlign:"center",padding:40}}><div className="aSpin" style={{width:36,height:36,border:`3px solid ${T.lav}`,borderTop:`3px solid ${T.purple}`,borderRadius:"50%",margin:"0 auto 12px"}}/><p style={{color:T.mid,fontWeight:700}}>Loading…</p></div>
    :<>
    {!inline&&<div style={{marginBottom:20}}><h2 style={{fontSize:24,fontWeight:900}}>Achievements</h2><p style={{fontSize:13,color:T.light,fontWeight:500}}>Your milestones & rewards</p></div>}
    <div className="pcard" style={{background:T.lavBg,marginBottom:16,textAlign:"center",padding:inline?"16px 14px":"26px 20px"}}>
      <div style={{fontSize:inline?44:60,animation:"float 3s ease-in-out infinite",display:"block",marginBottom:8}}>🏆</div>
      <p style={{fontSize:inline?32:40,fontWeight:900,color:T.navy,lineHeight:1}}>Level {level}</p>
      <p style={{fontSize:13,color:T.mid,fontWeight:600,marginTop:4}}>Nutrition Warrior</p>
      <div style={{margin:"12px 0"}}><div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:700,color:T.mid,marginBottom:6}}><span>{inLevel} XP</span><span>{300-inLevel} XP to next</span></div><div style={{background:"rgba(255,255,255,.6)",borderRadius:5,height:8,overflow:"hidden"}}><div style={{width:`${(inLevel/300)*100}%`,height:"100%",background:T.purple,borderRadius:5,transition:"width 1s"}}/></div></div>
      <div style={{display:"flex",justifyContent:"center",gap:24}}>{[{l:"Total XP",v:total},{l:"Streak",v:`${streak} 🔥`},{l:"Earned",v:`${[...earned].length}/${defs.length}`}].map(s=><div key={s.l}><p style={{fontSize:18,fontWeight:900,color:T.navy}}>{s.v}</p><p style={{fontSize:11,color:T.mid,fontWeight:600}}>{s.l}</p></div>)}</div>
    </div>
    {!inline&&<div className="card" style={{marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:14}}><div style={{fontSize:44,animation:"float 2.5s ease-in-out infinite"}}>🔥</div><div><p style={{fontSize:20,fontWeight:900}}>{streak>=7?"Streak master!":`${streak}-Day Streak`}</p><p style={{fontSize:13,color:T.light,fontWeight:500}}>Keep going for the 30-day badge</p></div></div>
      <div style={{display:"flex",gap:6}}>{(calWeek.length?calWeek:[{label:"M",ok:false},{label:"T",ok:false},{label:"W",ok:false},{label:"T",ok:false},{label:"F",ok:false},{label:"S",ok:false},{label:"S",ok:false}]).map((x,i)=><div key={i} style={{flex:1,textAlign:"center",padding:"7px 2px",borderRadius:10,background:x.ok?T.mintBg:T.lavBg,border:`2px solid ${x.ok?T.green:T.lav}`}}><p style={{fontSize:10,color:T.light,fontWeight:700}}>{x.label}</p><p style={{fontSize:15,marginTop:2}}>{x.ok?"🔥":"·"}</p></div>)}</div>
    </div>}
    <p style={{fontSize:14,fontWeight:800,marginBottom:10}}>All Achievements</p>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {defs.map(a=>{
        const ok=earned.has(a.id);
        return <div key={a.id} className={`ach-row${ok?" unlocked":""}`} onClick={()=>ok?toast(`${a.title} earned! +${a.xp} XP`,"🏆"):toast(`Keep going! Close to ${a.title}`,"💪")}>
        <div style={{width:inline?42:52,height:inline?42:52,borderRadius:14,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:inline?22:26,boxShadow:`0 2px 8px ${T.shadow}`,filter:ok?"none":"grayscale(1) opacity(.35)"}}>{a.e}</div>
        <div style={{flex:1}}><p style={{fontWeight:800,fontSize:14,color:ok?T.text:T.light}}>{a.title}</p><p style={{fontSize:12,color:T.light,fontWeight:500,marginTop:2}}>{a.desc}</p></div>
        <div style={{textAlign:"right"}}>{ok?<div><span className="badge" style={{background:T.white,color:T.purple}}>+{a.xp} XP</span><p style={{fontSize:10,color:T.green,fontWeight:700,marginTop:4}}>✓ Earned</p></div>:<span className="badge" style={{background:T.bg,color:T.light}}>{a.xp} XP</span>}</div>
      </div>;})}
    </div>
  </>;
  if(inline)return inner;
  return <div style={{paddingBottom:110}}><SBar/>
    <div style={{padding:"4px 16px 20px",maxWidth:600,margin:"0 auto",width:"100%"}}>{inner}</div>
  </div>;
}

/* ══════════════ SETTINGS SCREEN ══════════════ */
function Settings({user,setUser,toast,onSignOut,settings,setSetting,meals=[],onDataCleared,soundFxEnabled,setSoundFxEnabled,playSfx,online,aiConfigured}){
  const [sheet,setSheet]=useState(null);
  const [pwForm,setPwForm]=useState({cur:"",nw:"",conf:""});
  const [showPws,setShowPws]=useState({cur:false,nw:false,conf:false});
  const [editForm,setEditForm]=useState(user);
  const [profileEditing,setProfileEditing]=useState(false);
  const [units,setUnits]=useState(()=>{try{return localStorage.getItem("nutriscan_units")||"metric";}catch(e){return"metric";}});
  const [profileAvatar,setProfileAvatar]=useState(()=>{try{return parseInt(localStorage.getItem("nutriscan_avatar"))||0;}catch(e){return 0;}});
  const [profileImageUploading,setProfileImageUploading]=useState(false);
  const [feedbackText,setFeedbackText]=useState("");
  const [feedbackSending,setFeedbackSending]=useState(false);
  const [clearingData,setClearingData]=useState(false);
  const [weightSinceFirst,setWeightSinceFirst]=useState(null);
  const [diagLoading,setDiagLoading]=useState(false);
  const [diag,setDiag]=useState(null);
  const bmr=fBMR(user.gender,+user.weight,+user.height,+user.age);
  const tdee=fTDEE(bmr,user.activity),tgt=fTarget(tdee,user.goal);
  const bmi=parseFloat(fBMI(user.weight,user.height)),bi=fBMIlabel(bmi);
  const avatarLetter=(user?.name?.trim?.()?.[0]||"U").toUpperCase();
  const sleepHour=Math.min(23,Math.max(0,parseInt(settings?.sleepReminderHour,10)||0));
  const sleepMinute=Math.min(59,Math.max(0,parseInt(settings?.sleepReminderMinute,10)||0));
  const sleepTimeLabel=new Date(2000,0,1,sleepHour,sleepMinute,0,0).toLocaleTimeString([], {hour:"numeric",minute:"2-digit",hour12:true});

  useEffect(()=>{
    const idx=PROFILE_GALLERY_IMAGES.findIndex(u=>u===user?.profileImageUrl);
    if(idx>=0&&idx!==profileAvatar)setProfileAvatar(idx);
  },[user?.profileImageUrl,profileAvatar]);

  const runDiagnostics=async()=>{
    setDiagLoading(true);
    const info={
      network:online?"Online":"Offline",
      auth:user?.token?"Signed in":"No session",
      aiKey:aiConfigured?"Configured":"Missing",
      platform:isNativeApp()?"Native app":"Web",
      camera:"Unknown",
      notifications:"Unknown",
      exactAlarm:"Unknown",
      checkedAt:new Date().toLocaleString(),
    };
    if(isNativeApp()){
      try{
        const cp=await Camera.checkPermissions();
        info.camera=cp?.camera||"unknown";
      }catch(e){
        info.camera="error";
      }
      try{
        const np=await LocalNotifications.checkPermissions();
        info.notifications=np?.display||"unknown";
      }catch(e){
        info.notifications="error";
      }
      try{
        if(typeof LocalNotifications.checkExactNotificationSetting==="function"){
          const exact=await LocalNotifications.checkExactNotificationSetting();
          info.exactAlarm=exact?.value||"unknown";
        }else info.exactAlarm="not supported";
      }catch(e){
        info.exactAlarm="error";
      }
    }else{
      info.camera="n/a (web)";
      info.notifications="n/a (web)";
      info.exactAlarm="n/a (web)";
    }
    setDiag(info);
    setDiagLoading(false);
    toast("Diagnostics updated","🩺");
  };

  const runNotificationDiagnostic=async()=>{
    if(!isNativeApp()){
      toast("Notification test is available on mobile app only.","ℹ️");
      return;
    }
    const testAt=new Date(Date.now()+60*1000);
    const ok=await scheduleDailyReminderExample({
      id:3998,
      title:"🧪 Notification Diagnostic",
      body:"If you see this at the expected minute, local notification timing is healthy.",
      hour:testAt.getHours(),
      minute:testAt.getMinutes(),
    });
    if(ok)toast(`Test notification scheduled for ${testAt.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})}`,"⏰");
    else toast("Couldn't schedule test notification.","❌");
  };

  const changeProfilePicture=async()=>{
    if(!user?.token||!user?.id){toast("Please sign in first.","❌");return;}
    const remainingMs=getAvatarRemainingMs(user?.lastAvatarUpdate);
    if(remainingMs>0){
      toast(`You can change your profile picture again in ${remainingDaysLabel(remainingMs)} day${remainingDaysLabel(remainingMs)===1?"":"s"}.`,"⏳");
      return;
    }
    setProfileImageUploading(true);
    try{
      const oldUrl=String(user?.profileImageUrl||"");
      const oldPath=extractStorageObjectPath(oldUrl,PROFILE_IMAGE_BUCKET);
      const photo=await Camera.getPhoto({
        quality:85,
        resultType:CameraResultType.Base64,
        source:CameraSource.Prompt,
        promptLabelHeader:"Profile Photo",
        promptLabelPicture:"Take Photo",
        promptLabelPhoto:"Choose from Gallery",
        promptLabelCancel:"Cancel",
      });
      if(!photo?.base64String){setProfileImageUploading(false);return;}
      const fmt=String(photo.format||"jpeg").toLowerCase();
      const ext=fmt==="jpg"?"jpeg":(fmt||"jpeg");
      const mime=ext==="png"?"image/png":ext==="webp"?"image/webp":"image/jpeg";
      const blob=base64ToBlob(photo.base64String,mime);
      const filename=`avatar_${Date.now()}.${ext}`;
      const publicUrl=await uploadProfileImageToCloudinary(blob,filename);
      const ok=await supa.patch(user.token,"profiles",`id=eq.${user.id}`,{profile_image_url:publicUrl});
      if(!ok){
        throw new Error("Couldn't save profile image URL");
      }
      setUser(prev=>prev?{...prev,profileImageUrl:publicUrl,lastAvatarUpdate:new Date().toISOString()}:prev);
      setEditForm(prev=>({...prev,profileImageUrl:publicUrl}));
      toast("Profile picture updated!","✅");
    }catch(e){
      const m=String(e?.message||"");
      const cd=parseAvatarCooldownDays(m);
      if(cd){toast(`You can change your profile picture again in ${cd} day${cd===1?"":"s"}.`,"⏳");setProfileImageUploading(false);return;}
      if(!/cancel|canceled|user cancelled/i.test(m))toast(m&&/permission/i.test(m)?"Camera/gallery permission denied.":"Could not update picture.","❌");
    }
    setProfileImageUploading(false);
  };

  const chooseProfileFromGallery=async(imageUrl,idx)=>{
    if(!user?.token||!user?.id){toast("Please sign in first.","❌");return;}
    if(!imageUrl){toast("Image not available.","❌");return;}
    const remainingMs=getAvatarRemainingMs(user?.lastAvatarUpdate);
    if(remainingMs>0){
      toast(`You can change your profile picture again in ${remainingDaysLabel(remainingMs)} day${remainingDaysLabel(remainingMs)===1?"":"s"}.`,"⏳");
      return;
    }
    setProfileImageUploading(true);
    try{
      let finalUrl=String(imageUrl||"");
      try{
        const assetRes=await fetch(imageUrl);
        if(assetRes.ok){
          const assetBlob=await assetRes.blob();
          const assetExt=((assetBlob.type||"image/jpeg").split("/")[1]||"jpeg").toLowerCase();
          const fileExt=assetExt==="svg+xml"?"svg":assetExt;
          const cloudUrl=await uploadProfileImageToCloudinary(assetBlob,`app_avatar_${idx+1}_${Date.now()}.${fileExt}`);
          if(cloudUrl)finalUrl=cloudUrl;
        }
      }catch(_e){}

      const ok=await supa.patch(user.token,"profiles",`id=eq.${user.id}`,{profile_image_url:finalUrl});
      if(!ok)throw new Error("Couldn't save profile image");
      setProfileAvatar(idx);
      setUser(prev=>prev?{...prev,profileImageUrl:finalUrl,lastAvatarUpdate:new Date().toISOString()}:prev);
      setEditForm(prev=>({...prev,profileImageUrl:finalUrl}));
      toast("Profile photo updated!","🖼️");
      setSheet(null);
    }catch(e){
      const cd=parseAvatarCooldownDays(e?.message);
      if(cd){toast(`You can change your profile picture again in ${cd} day${cd===1?"":"s"}.`,"⏳");}
      else toast("Could not set profile photo.","❌");
    }
    setProfileImageUploading(false);
  };

  const clearAllData=async()=>{
    if(clearingData)return;
    setClearingData(true);
    try{
      if(user?.token&&user?.id){
        const f=`user_id=eq.${user.id}`;
        await Promise.allSettled([
          supa.del(user.token,"meals",f),
          supa.del(user.token,"water_logs",f),
          supa.del(user.token,"weight_logs",f),
          supa.del(user.token,"achievements",f),
          supa.del(user.token,"chat_messages",f),
        ]);
      }

      try{
        const prefix=`nutriscan_local_${user?.id||""}_`;
        const keys=[];
        for(let i=0;i<localStorage.length;i++){
          const key=localStorage.key(i);
          if(key&&key.startsWith(prefix))keys.push(key);
        }
        for(const key of keys)localStorage.removeItem(key);
      }catch(e){}

      writeOfflineQueue([]);
      onDataCleared&&onDataCleared();
      toast("All data cleared","🗑️");
      setSheet(null);
    }catch(e){
      toast("Couldn't clear data","❌");
    }
    setClearingData(false);
  };

  const saveProfile=async()=>{
    if(!user?.token){
      setUser({...user,...editForm,age:String(editForm.age),height:String(editForm.height),weight:String(editForm.weight)});
      toast("Profile updated!","✅");
      setSheet(null);
      return;
    }
    const age=parseInt(editForm.age,10)||28;
    const height=parseFloat(editForm.height)||170;
    const weight=parseFloat(editForm.weight)||70;
    const ok=await supa.patch(user.token,"profiles",`id=eq.${user.id}`,{
      name:editForm.name,
      age,
      gender:editForm.gender||"male",
      height,
      weight,
      activity:editForm.activity,
      goal:editForm.goal,
    });
    if(ok){
      setUser({...user,name:editForm.name,age:String(age),gender:editForm.gender||"male",height:String(height),weight:String(weight),activity:editForm.activity,goal:editForm.goal});
      toast("Profile updated!","✅");
      setSheet(null);
    }else toast("Couldn't save profile","❌");
  };
  const changePw=()=>{if(pwForm.nw.length<8){toast("Password must be 8+ characters","❌");return;}if(pwForm.nw!==pwForm.conf){toast("Passwords don't match","❌");return;}toast("Password changed successfully!","✅");setSheet(null);setPwForm({cur:"",nw:"",conf:""});};

  useEffect(()=>{try{localStorage.setItem("nutriscan_units",units);}catch(e){}},[units]);
  useEffect(()=>{try{localStorage.setItem("nutriscan_avatar",String(profileAvatar));}catch(e){}},[profileAvatar]);

  const downloadText=(filename,text,mime)=>{
    try{
      const blob=new Blob([text],{type:mime});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;
      a.download=filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return true;
    }catch(e){return false;}
  };

  const exportData=(kind)=>{
    const now=new Date();
    const stamp=`${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
    if(kind==="JSON"){
      const payload={
        exportedAt:now.toISOString(),
        user:{id:user?.id,name:user?.name,email:user?.email,age:user?.age,gender:user?.gender,height:user?.height,weight:user?.weight,activity:user?.activity,goal:user?.goal},
        meals,
        settings,
      };
      const ok=downloadText(`nutriscan_export_${stamp}.json`,JSON.stringify(payload,null,2),"application/json;charset=utf-8");
      toast(ok?"JSON exported":"Export failed",ok?"✅":"❌");
      return;
    }
    const rows=[["name","calories","protein_g","carbs_g","fat_g","meal_type","time","emoji"],...meals.map(m=>[m.name,m.cal,m.p||0,m.c||0,m.f||0,m.m||"Snack",m.t||"",m.e||"🍽️"] )];
    const csv=rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");
    if(kind==="CSV"){
      const ok=downloadText(`nutriscan_export_${stamp}.csv`,csv,"text/csv;charset=utf-8");
      toast(ok?"CSV exported":"Export failed",ok?"✅":"❌");
      return;
    }
    const report=[
      "NutriScan Report",
      `Generated: ${now.toLocaleString()}`,
      "",
      `User: ${user?.name||""} (${user?.email||""})`,
      `Goal: ${user?.goal||""}`,
      `Activity: ${user?.activity||""}`,
      "",
      "Meals:",
      ...meals.map(m=>`- ${m.name} | ${m.cal} kcal | P:${m.p||0} C:${m.c||0} F:${m.f||0} | ${m.m||"Snack"} ${m.t||""}`),
      "",
      "(Tip: open this report in any text/PDF converter app.)",
    ].join("\n");
    const ok=downloadText(`nutriscan_report_${stamp}.txt`,report,"text/plain;charset=utf-8");
    toast(ok?"Report exported":"Export failed",ok?"✅":"❌");
  };

  const submitFeedback=async()=>{
    const text=feedbackText.trim();
    if(!text){toast("Please enter your feedback first.","❌");return;}
    if(!WEB3FORMS_ACCESS_KEY){toast("Feedback is not configured yet.","❌");return;}
    setFeedbackSending(true);
    try{
      const r=await fetch(WEB3FORMS_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        access_key:WEB3FORMS_ACCESS_KEY,
        subject:"NutriScan App Feedback",
        from_name:user?.name||"NutriScan User",
        email:user?.email||"",
        message:text,
        source:"NutriScan Mobile App",
      })});
      const data=await r.json().catch(()=>({}));
      if(!r.ok||!data?.success)throw new Error(data?.message||`Feedback ${r.status}`);
      toast("Feedback sent successfully.","✅");
      setFeedbackText("");
      setSheet(null);
    }catch(e){toast("Could not send feedback.","❌");}
    setFeedbackSending(false);
  };

  useEffect(()=>{
    if(!user?.token||!user?.id){setWeightSinceFirst(null);return;}
    let cancel=false;
    (async()=>{
      try{
        const rows=await supa.select(user.token,"weight_logs","weight,logged_at",`&user_id=eq.${user.id}&order=logged_at.asc`);
        if(cancel||!Array.isArray(rows)||rows.length<1){if(!cancel)setWeightSinceFirst(null);return;}
        const first=+rows[0].weight,last=+rows[rows.length-1].weight;
        if(!cancel)setWeightSinceFirst({first,last,delta:Math.round((first-last)*10)/10});
      }catch(e){if(!cancel)setWeightSinceFirst(null);}
    })();
    return()=>{cancel=true;};
  },[user?.id,user?.token,user?.weight]);

  return <div style={{paddingBottom:110}}><SBar/>
    <div style={{padding:"4px 16px 20px",maxWidth:600,margin:"0 auto",width:"100%"}}>
      <div style={{marginBottom:20}}><h2 style={{fontSize:24,fontWeight:900}}>Settings</h2><p style={{fontSize:13,color:T.light}}>Manage your account & preferences</p></div>

      {/* Profile card */}
      <div className="pcard" style={{background:T.lavBg,marginBottom:16,cursor:"pointer"}} onClick={()=>{setEditForm(user);setSheet("profile");}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <div className="avatar" style={{width:56,height:56,fontSize:22,boxShadow:`0 4px 12px ${T.shadow}`,background:"linear-gradient(135deg, #7B6FBF 0%, #9D93D8 100%)",overflow:"hidden"}}>
            {user?.profileImageUrl
              ?<img src={user.profileImageUrl} alt="Profile" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              :avatarLetter}
          </div>
          <div style={{flex:1}}>
            <p style={{fontSize:17,fontWeight:900}}>{user.name}</p>
            <p style={{fontSize:13,color:T.mid,fontWeight:600,marginTop:2}}>{user.email}</p>
            <div style={{display:"flex",gap:16,marginTop:8,flexWrap:"wrap"}}>
              <div style={{textAlign:"center"}}><p style={{fontSize:14,fontWeight:900}}>{bmi}</p><p style={{fontSize:10,color:T.mid}}>BMI</p></div>
              <div style={{textAlign:"center"}}><p style={{fontSize:14,fontWeight:900}}>{user.weight}kg</p><p style={{fontSize:10,color:T.mid}}>Weight</p></div>
              <div style={{textAlign:"center"}}><p style={{fontSize:14,fontWeight:900,color:bi.c}}>{bi.l}</p><p style={{fontSize:10,color:T.mid}}>Status</p></div>
            </div>
            {weightSinceFirst!=null&&<p style={{fontSize:12,color:T.mid,fontWeight:600,marginTop:10,lineHeight:1.4}}>
              {weightSinceFirst.delta===0?"No change since first log."
                :weightSinceFirst.delta>0
                  ?`Since first log (${weightSinceFirst.first} kg): down ${weightSinceFirst.delta} kg`
                  :`Since first log (${weightSinceFirst.first} kg): up ${-weightSinceFirst.delta} kg`}
            </p>}
          </div>
          <span style={{color:T.mid,fontSize:20}}>›</span>
        </div>
      </div>

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
        {[{l:"BMR",v:Math.round(bmr),i:"🔋",bg:T.peachBg},{l:"TDEE",v:Math.round(tdee),i:"⚡",bg:T.mintBg},{l:"Target",v:tgt,i:"🎯",bg:T.lavBg},{l:"Activity",v:user.activity[0].toUpperCase()+user.activity.slice(1),i:"🏃",bg:T.pinkBg}].map(s=><div key={s.l} className="pcard" style={{background:s.bg,padding:"13px"}}><p style={{fontSize:18}}>{s.i}</p><p style={{fontSize:19,fontWeight:900,marginTop:6}}>{s.v}</p><p style={{fontSize:10,color:T.mid,fontWeight:600,marginTop:1}}>{s.l}</p></div>)}
      </div>

      {/* NOTIFICATIONS */}
      <div className="card" style={{marginBottom:14}}>
        <p style={{fontSize:15,fontWeight:800,marginBottom:4}}>Notifications</p>
        <SettingRow icon={Ic.food} iconBg={T.pinkBg} label="Meal Reminders (Phone)" sub={settings.mealReminders?"Phone reminders + nudges are on":"Phone reminders are off"} right={<Toggle on={settings.mealReminders} set={v=>{setSetting("mealReminders",v);toast(v?"Phone meal reminders on":"Phone meal reminders off",v?"🍽️":"🔕");}}/>}/>
        <SettingRow icon={Ic.drop} iconBg={T.lavBg} label="Water Reminders (Phone)" sub={settings.waterReminders?"Every 2 hours (9:00 AM–9:00 PM)":"Off"} right={<Toggle on={settings.waterReminders} set={v=>{setSetting("waterReminders",v);toast(v?"Phone water reminders on (9:00 AM–9:00 PM)":"Phone water reminders off",v?"💧":"🔕");}}/>}/>
        <SettingRow icon={Ic.moon} iconBg={T.mintBg} label="Sleep Reminder (Phone)" sub={settings.sleepReminderEnabled?`Daily at ${sleepTimeLabel}`:"Off"} right={<Toggle on={!!settings.sleepReminderEnabled} set={v=>{setSetting("sleepReminderEnabled",v);toast(v?`Sleep reminder on (${sleepTimeLabel})`:"Sleep reminder off",v?"🌙":"🔕");}}/>} onClick={()=>setSheet("sleepReminder")}/>
        <SettingRow icon={Ic.heart} iconBg={T.mintBg} label="Health Insights" sub={settings.healthInsights?"Weekly AI insights":"Off"} right={<Toggle on={settings.healthInsights} set={v=>{setSetting("healthInsights",v);toast(v?"Health insights on":"Health insights off",v?"🤖":"🔕");}}/>}/>
        <SettingRow icon={Ic.trophy} iconBg={T.peachBg} label="Achievement Alerts (In-App)" sub={settings.achievementAlerts?"Milestones shown inside app":"Off"} right={<Toggle on={settings.achievementAlerts} set={v=>{setSetting("achievementAlerts",v);toast(v?"In-app achievement alerts on":"In-app achievement alerts off",v?"🏆":"🔕");}}/>}/>
      </div>

      {/* APPEARANCE */}
      <div className="card" style={{marginBottom:14}}>
        <p style={{fontSize:15,fontWeight:800,marginBottom:4}}>Appearance</p>
        <SettingRow icon={Ic.moon} iconBg={T.lavBg} label="Dark Mode" sub={settings.darkMode?"Dark theme active":"Light theme active"} right={<Toggle on={settings.darkMode} set={v=>{setSetting("darkMode",v);toast(v?"Dark mode on 🌙":"Light mode on ☀️",v?"🌙":"☀️");}}/>}/>
        <SettingRow icon={Ic.notification} iconBg={T.peachBg} label="Sound Effects" sub={soundFxEnabled?"Subtle app sounds on":"Sounds off"} right={<Toggle on={soundFxEnabled} set={v=>{setSoundFxEnabled(v);if(v){playSfx&&playSfx("success");}toast(v?"Sound effects on":"Sound effects off",v?"🔊":"🔇");}}/>}/>
        <SettingRow icon={Ic.font} iconBg={T.mintBg} label="Units" sub={units} onClick={()=>setSheet("units")}/>
      </div>

      {/* HEALTH */}
      <div className="card" style={{marginBottom:14}}>
        <p style={{fontSize:15,fontWeight:800,marginBottom:4}}>Health & Data</p>
        <SettingRow icon={Ic.wifi} iconBg={T.mintBg} label="Offline Mode" sub={settings.offline?"Data saved locally":"Online only"} right={<Toggle on={settings.offline} set={v=>{setSetting("offline",v);toast(v?"Offline mode on":"Online mode","📡");}}/>}/>
        <SettingRow icon={<span style={{fontSize:17}}>🩺</span>} iconBg={T.bg} label="Diagnostics" sub="Check app health" onClick={()=>{setSheet("diagnostics");runDiagnostics();}}/>
        <SettingRow icon={<span style={{fontSize:17}}>📊</span>} iconBg={T.peachBg} label="Connected Apps" sub="Apple Health, Google Fit" onClick={()=>{toast("Health app sync coming soon!","🔗");}}/>
        <SettingRow icon={<span style={{fontSize:17}}>🗑️</span>} iconBg={T.pinkBg} label="Clear All Data" sub="Reset your history" onClick={()=>setSheet("clearData")}/>
      </div>

      {/* ACCOUNT & SECURITY */}
      <div className="card" style={{marginBottom:14}}>
        <p style={{fontSize:15,fontWeight:800,marginBottom:4}}>Account & Security</p>
        <SettingRow icon={Ic.lock} iconBg={T.pinkBg} label="Change Password" sub="Update your password" onClick={()=>setSheet("password")}/>
        <SettingRow icon={<span style={{fontSize:17}}>📧</span>} iconBg={T.peachBg} label="Email Address" sub={user.email} onClick={()=>setSheet("changeEmail")}/>
      </div>

      {/* ABOUT */}
      <div className="card" style={{marginBottom:16}}>
        <p style={{fontSize:15,fontWeight:800,marginBottom:4}}>About</p>
        <SettingRow icon={<span style={{fontSize:17}}>⭐</span>} iconBg={T.peachBg} label="Rate NutriScan" sub="Enjoying the app?" onClick={()=>toast("Thank you for the support! ⭐","🙏")}/>
        <SettingRow icon={<span style={{fontSize:17}}>💬</span>} iconBg={T.mintBg} label="Send Feedback" sub="Help us improve" onClick={()=>setSheet("feedback")}/>
        <SettingRow icon={<span style={{fontSize:17}}>📄</span>} iconBg={T.lavBg} label="Privacy Policy" sub="How we use your data" onClick={()=>toast("Opening Privacy Policy…","📄")}/>
        <SettingRow icon={<span style={{fontSize:17}}>ℹ️</span>} iconBg={T.bg} label="App Version" sub="NutriScan v2.1.1" right={<span className="badge" style={{background:T.mintBg,color:T.green,fontSize:11}}>Latest</span>}/>
      </div>

      {/* Sign Out */}
      <button className="btn btn-danger" onClick={()=>setSheet("signout")}>
        {Ic.logout} Sign Out
      </button>
    </div>

    {/* ── SHEETS / MODALS ── */}

    {/* Profile Edit */}
    {sheet==="profile"&&<Sheet title="✏️ Edit Profile" onClose={()=>setSheet(null)}>
      <div style={{display:"flex",flexDirection:"column",gap:14,marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px",borderRadius:14,background:T.bg}}>
          <div className="avatar" style={{width:52,height:52,fontSize:20,background:"linear-gradient(135deg, #7B6FBF 0%, #9D93D8 100%)",overflow:"hidden"}}>
            {user?.profileImageUrl
              ?<img src={user.profileImageUrl} alt="Profile" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              :avatarLetter}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:8,flex:1}}>
            <button className="btn btn-ghost" style={{border:"2px solid "+T.border}} onClick={changeProfilePicture} disabled={profileImageUploading}>{profileImageUploading?"Updating…":"Upload from Camera/Gallery"}</button>
            <button className="btn btn-ghost" style={{border:"2px solid "+T.border}} onClick={()=>setSheet("avatar")} disabled={profileImageUploading||!PROFILE_GALLERY_IMAGES.length}>{PROFILE_GALLERY_IMAGES.length?"Choose from App Gallery":"No gallery images found"}</button>
          </div>
        </div>
        {[{k:"name",l:"Full Name",t:"text"},{k:"age",l:"Age",t:"number"},{k:"weight",l:"Weight (kg)",t:"number"},{k:"height",l:"Height (cm)",t:"number"}].map(f=><div key={f.k}><label className="flabel">{f.l}</label><input className="inp" type={f.t} value={editForm[f.k]} onChange={e=>setEditForm(p=>({...p,[f.k]:e.target.value}))}/></div>)}
        <div><label className="flabel">Gender</label><select className="inp" value={editForm.gender||"male"} onChange={e=>setEditForm(p=>({...p,gender:e.target.value}))}><option value="male">Male</option><option value="female">Female</option></select></div>
        <div><label className="flabel">Goal</label><select className="inp" value={editForm.goal} onChange={e=>setEditForm(p=>({...p,goal:e.target.value}))}><option value="loss">Weight Loss</option><option value="maintain">Maintain</option><option value="gain">Muscle Gain</option></select></div>
        <div><label className="flabel">Activity Level</label><select className="inp" value={editForm.activity} onChange={e=>setEditForm(p=>({...p,activity:e.target.value}))}><option value="low">Sedentary</option><option value="moderate">Moderately Active</option><option value="high">Very Active</option></select></div>
      </div>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-ghost" style={{flex:1,border:"2px solid "+T.border}} onClick={()=>{setEditForm({...user});setSheet(null);}}>Cancel</button>
        <button className="btn btn-primary" style={{flex:1}} onClick={saveProfile}>Save Changes</button>
      </div>
    </Sheet>}

    {sheet==="sleepReminder"&&<Sheet title="🌙 Sleep Reminder" onClose={()=>setSheet(null)}>
      <div style={{display:"flex",flexDirection:"column",gap:14,marginBottom:18}}>
        <p style={{fontSize:13,color:T.mid,fontWeight:600}}>Choose the exact time for your daily sleep reminder.</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>
            <label className="flabel">Hour (0–23)</label>
            <select className="inp" value={sleepHour} onChange={e=>setSetting("sleepReminderHour",parseInt(e.target.value,10))}>
              {Array.from({length:24},(_,h)=><option key={h} value={h}>{String(h).padStart(2,"0")}</option>)}
            </select>
          </div>
          <div>
            <label className="flabel">Minute</label>
            <select className="inp" value={sleepMinute} onChange={e=>setSetting("sleepReminderMinute",parseInt(e.target.value,10))}>
              {Array.from({length:60},(_,m)=><option key={m} value={m}>{String(m).padStart(2,"0")}</option>)}
            </select>
          </div>
        </div>
        <p style={{fontSize:13,fontWeight:700,color:T.navy}}>Current: {sleepTimeLabel}</p>
      </div>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-ghost" style={{flex:1,border:`2px solid ${T.border}`}} onClick={()=>setSetting("sleepReminderEnabled",false)}>Turn Off</button>
        <button className="btn btn-primary" style={{flex:1}} onClick={()=>{setSetting("sleepReminderEnabled",true);toast(`Sleep reminder set for ${sleepTimeLabel}`,"🌙");setSheet(null);}}>Save</button>
      </div>
    </Sheet>}

    {/* Change Password */}
    {sheet==="password"&&<Sheet title="🔑 Change Password" onClose={()=>setSheet(null)}>
      <div style={{display:"flex",flexDirection:"column",gap:14,marginBottom:20}}>
        {[{k:"cur",l:"Current Password"},{k:"nw",l:"New Password"},{k:"conf",l:"Confirm New Password"}].map(f=><div key={f.k}><label className="flabel">{f.l}</label><div className="inp-wrap"><input className="inp inp-padr" type={showPws[f.k]?"text":"password"} placeholder="••••••••" value={pwForm[f.k]} onChange={e=>setPwForm(p=>({...p,[f.k]:e.target.value}))}/><span className="inp-icon-right" onClick={()=>setShowPws(p=>({...p,[f.k]:!p[f.k]}))}>{showPws[f.k]?Ic.eyeOff:Ic.eye}</span></div></div>)}
        {pwForm.nw&&<div><div style={{display:"flex",gap:4,marginBottom:4}}>{[1,2,3,4].map(i=><div key={i} style={{flex:1,height:5,borderRadius:3,background:i<=pwStrength(pwForm.nw)?pwColor(pwStrength(pwForm.nw)):T.border,transition:"all .3s"}}/>)}</div><p style={{fontSize:12,fontWeight:700,color:pwColor(pwStrength(pwForm.nw))}}>{pwLabel(pwStrength(pwForm.nw))}</p></div>}
      </div>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-ghost" style={{flex:1,border:"2px solid "+T.border}} onClick={()=>setSheet(null)}>Cancel</button>
        <button className="btn btn-primary" style={{flex:1}} onClick={changePw}>Update Password</button>
      </div>
    </Sheet>}

    {/* Change Email */}
    {sheet==="changeEmail"&&<Sheet title="📧 Change Email" onClose={()=>setSheet(null)}>
      <p style={{fontSize:14,color:T.mid,marginBottom:16}}>Current: <strong>{user.email}</strong></p>
      <div style={{display:"flex",flexDirection:"column",gap:14,marginBottom:20}}>
        <div><label className="flabel">New Email</label><input className="inp" type="email" placeholder="new@example.com"/></div>
        <div><label className="flabel">Confirm Password</label><input className="inp" type="password" placeholder="••••••••"/></div>
      </div>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-ghost" style={{flex:1,border:"2px solid "+T.border}} onClick={()=>setSheet(null)}>Cancel</button>
        <button className="btn btn-primary" style={{flex:1}} onClick={()=>{toast("Verification email sent!","📧");setSheet(null);}}>Send Verification</button>
      </div>
    </Sheet>}

    {/* Export */}
    {sheet==="export"&&<Sheet title="📤 Export Data" onClose={()=>setSheet(null)}>
      <p style={{fontSize:14,color:T.mid,marginBottom:20}}>Download your complete nutrition history</p>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {[{t:"📄 PDF Report",s:"Full formatted report with charts",bg:T.pinkBg,fn:"PDF"},{t:"📊 CSV Spreadsheet",s:"Raw data for Excel / Google Sheets",bg:T.mintBg,fn:"CSV"},{t:"🗂️ JSON Export",s:"Complete data backup",bg:T.lavBg,fn:"JSON"}].map(x=><button key={x.fn} onClick={()=>{exportData(x.fn);setSheet(null);}} style={{width:"100%",padding:"16px",borderRadius:16,background:x.bg,border:"none",cursor:"pointer",textAlign:"left",fontFamily:"Nunito",transition:"all .18s"}} onMouseEnter={e=>e.currentTarget.style.filter="brightness(.96)"} onMouseLeave={e=>e.currentTarget.style.filter="none"}><p style={{fontSize:15,fontWeight:800}}>{x.t}</p><p style={{fontSize:12,color:T.mid,marginTop:4}}>{x.s}</p></button>)}
      </div>
    </Sheet>}

    {/* Units */}
    {sheet==="units"&&<Sheet title="📏 Units" onClose={()=>setSheet(null)}>
      {[{v:"metric",l:"Metric",s:"kg, cm, ml"},{v:"imperial",l:"Imperial",s:"lbs, ft, fl oz"}].map(u=><div key={u.v} onClick={()=>{setUnits(u.v);toast(`Units set to ${u.l}`,"📏");setSheet(null);}} style={{padding:"16px",borderRadius:16,cursor:"pointer",background:units===u.v?T.lavBg:T.bg,border:`2px solid ${units===u.v?T.purple:T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,transition:"all .18s"}}><div><p style={{fontWeight:800,fontSize:15}}>{u.l}</p><p style={{fontSize:12,color:T.light,marginTop:2}}>{u.s}</p></div>{units===u.v&&<div style={{color:T.purple}}>{Ic.check}</div>}</div>)}
    </Sheet>}

    {/* Avatar */}
    {sheet==="avatar"&&<Sheet title="🖼️ Profile Avatar" onClose={()=>setSheet(null)}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
        {PROFILE_GALLERY_IMAGES.map((imgUrl,idx)=>{
          const selected=profileAvatar===idx;
          return <button key={imgUrl} onClick={()=>chooseProfileFromGallery(imgUrl,idx)} style={{padding:"6px",borderRadius:14,border:`2px solid ${selected?T.purple:T.border}`,background:selected?T.lavBg:T.bg,cursor:"pointer",fontFamily:"Nunito",display:"flex",alignItems:"center",justifyContent:"center",aspectRatio:"1/1",overflow:"hidden"}}>
            <img src={imgUrl} alt={`Profile option ${idx+1}`} style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:10}}/>
          </button>;
        })}
      </div>
    </Sheet>}

    {/* Feedback */}
    {sheet==="feedback"&&<Sheet title="💬 Send Feedback" onClose={()=>setSheet(null)}>
      <p style={{fontSize:14,color:T.mid,marginBottom:16}}>We read every message. Thank you!</p>
      <div style={{marginBottom:14}}><label className="flabel">What's on your mind?</label><textarea className="inp" rows={5} value={feedbackText} onChange={e=>setFeedbackText(e.target.value)} placeholder="Tell us what you love, what's missing, or what can be improved…" style={{resize:"none",lineHeight:1.6}}/></div>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-ghost" style={{flex:1,border:"2px solid "+T.border}} onClick={()=>setSheet(null)}>Cancel</button>
        <button className="btn btn-primary" style={{flex:1}} onClick={submitFeedback} disabled={feedbackSending}>{feedbackSending?"Sending…":"Send Feedback"}</button>
      </div>
    </Sheet>}

    {/* Diagnostics */}
    {sheet==="diagnostics"&&<Sheet title="🩺 Diagnostics" onClose={()=>setSheet(null)}>
      <div className="card" style={{marginBottom:12}}>
        <p style={{fontSize:13,color:T.mid,fontWeight:700,marginBottom:10}}>Quick status checks</p>
        {diagLoading&&<p style={{fontSize:13,color:T.mid}}>Checking…</p>}
        {!diagLoading&&diag&&<div style={{display:"grid",gap:8}}>
          {[{k:"Network",v:diag.network},{k:"Auth",v:diag.auth},{k:"AI Key",v:diag.aiKey},{k:"Platform",v:diag.platform},{k:"Camera",v:diag.camera},{k:"Notifications",v:diag.notifications},{k:"Exact Alarm",v:diag.exactAlarm}].map(item=><div key={item.k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",background:T.bg,borderRadius:12}}><span style={{fontSize:12,fontWeight:700,color:T.mid}}>{item.k}</span><span style={{fontSize:12,fontWeight:800}}>{item.v}</span></div>)}
          <p style={{fontSize:11,color:T.light,marginTop:4}}>Last checked: {diag.checkedAt}</p>
        </div>}
      </div>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-primary" style={{flex:1}} onClick={runDiagnostics} disabled={diagLoading}>{diagLoading?"Checking…":"Run Diagnostics Again"}</button>
        <button className="btn btn-ghost" style={{flex:1,border:`2px solid ${T.border}`}} onClick={runNotificationDiagnostic}>Test Notification (+1 min)</button>
      </div>
    </Sheet>}

    {/* Clear Data Confirmation */}
    {sheet==="clearData"&&<ModalBox title="⚠️ Clear All Data" onClose={()=>setSheet(null)}>
      <p style={{fontSize:14,color:T.mid,lineHeight:1.6,marginBottom:24}}>This will permanently delete all your meal logs, weight history, and progress data. This action <strong style={{color:T.red}}>cannot be undone</strong>.</p>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-ghost" style={{flex:1,border:"2px solid "+T.border}} onClick={()=>setSheet(null)}>Keep My Data</button>
        <button className="btn btn-danger" style={{flex:1}} onClick={clearAllData} disabled={clearingData}>{clearingData?"Deleting…":"Delete Everything"}</button>
      </div>
    </ModalBox>}

    {/* Sign Out Confirmation */}
    {sheet==="signout"&&<ModalBox title="Sign Out" onClose={()=>setSheet(null)}>
      <p style={{fontSize:14,color:T.mid,marginBottom:24,lineHeight:1.6}}>Are you sure you want to sign out? Your data will be safely saved.</p>
      <div style={{display:"flex",gap:10}}>
        <button className="btn btn-ghost" style={{flex:1,border:"2px solid "+T.border}} onClick={()=>setSheet(null)}>Cancel</button>
        <button className="btn btn-danger" style={{flex:1}} onClick={()=>{setSheet(null);onSignOut();}}>Sign Out</button>
      </div>
    </ModalBox>}
  </div>;
}

/* ══════════════ NOTIFICATIONS SHEET ══════════════ */
function NotificationsSheet({notifications,onClose,toast,onMarkAllRead}){
  const list=notifications||[];
  return <Sheet title="🔔 Notifications" onClose={onClose} right={list.length>0?<button onClick={()=>{onMarkAllRead&&onMarkAllRead();toast("All read","✅");}} style={{fontSize:12,fontWeight:700,color:T.purple,background:"none",border:"none",cursor:"pointer",fontFamily:"Nunito"}}>Mark all</button>:null}>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {list.length===0&&<p style={{textAlign:"center",color:T.light,padding:24,fontWeight:600}}>You're all caught up!</p>}
      {list.map((n,i)=><div key={n.id||i} style={{display:"flex",gap:12,padding:"14px",borderRadius:16,background:n.unread?T.lavBg:T.bg,border:`2px solid ${n.unread?T.lav:T.border}`,cursor:"default",transition:"all .18s"}}>
        <div style={{width:44,height:44,borderRadius:14,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:`0 2px 6px ${T.shadow}`,flexShrink:0}}>{n.e}</div>
        <div style={{flex:1}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}><p style={{fontSize:14,fontWeight:n.unread?800:600}}>{n.title}</p>{n.unread&&<div style={{width:8,height:8,borderRadius:"50%",background:T.purple,marginTop:4,flexShrink:0}}/>}</div>
          <p style={{fontSize:12,color:T.light,marginTop:2,lineHeight:1.4}}>{n.sub}</p>
          <p style={{fontSize:11,color:T.light,marginTop:4}}>{n.t}</p>
        </div>
      </div>)}
    </div>
  </Sheet>;
}

/* ══════════════ SEARCH SCREEN ══════════════ */
function SearchScreen({meals,onClose,toast}){
  const [q,setQ]=useState("");
  const all=[...INDIAN,...RECS.map(r=>({name:r.n,cal:r.c,p:r.p||0,c:r.carb||0,f:r.f||0,e:r.e}))];
  const results=q.trim()?all.filter(f=>f.name.toLowerCase().includes(q.toLowerCase())):[];
  return <div className="search-overlay" style={{padding:"0 0 40px"}}><SBar/>
    <div style={{padding:"0 16px",maxWidth:600,margin:"0 auto",width:"100%"}}>
      <div style={{display:"flex",gap:12,alignItems:"center",marginBottom:24}}>
        <button className="btn-icon" onClick={onClose}>{Ic.arrowL}</button>
        <div style={{flex:1,position:"relative"}}><span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",color:T.light}}>{Ic.search}</span><input className="inp inp-padl" autoFocus placeholder="Search food, meals…" value={q} onChange={e=>setQ(e.target.value)} style={{background:T.white}}/></div>
      </div>
      {!q&&<><p style={{fontSize:13,fontWeight:700,color:T.mid,textTransform:"uppercase",letterSpacing:1,marginBottom:12}}>Today's Logged</p>
        {meals.map(m=><div key={m.id} className="meal-row" style={{marginBottom:8}}>
          <div style={{width:42,height:42,borderRadius:13,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:`0 2px 6px ${T.shadow}`}}>{m.e}</div>
          <div style={{flex:1}}><p style={{fontSize:14,fontWeight:700}}>{m.name}</p><p style={{fontSize:11,color:T.light}}>{m.m} · {m.t}</p></div>
          <p style={{fontSize:15,fontWeight:900,color:T.purple}}>{m.cal} kcal</p>
        </div>)}</>}
      {q&&<><p style={{fontSize:13,fontWeight:700,color:T.mid,marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>{results.length} result{results.length!==1?"s":""}</p>
        {results.length===0&&<div style={{textAlign:"center",padding:"40px 0",color:T.light}}><div style={{fontSize:48,marginBottom:12}}>🔍</div><p style={{fontWeight:600}}>No results for "{q}"</p></div>}
        {results.map((f,i)=><div key={i} className="meal-row" style={{marginBottom:8}} onClick={()=>{toast(`${f.name} added!`,"✅");onClose();}}>
          <div style={{width:42,height:42,borderRadius:13,background:T.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:`0 2px 6px ${T.shadow}`}}>{f.e}</div>
          <div style={{flex:1}}><p style={{fontSize:14,fontWeight:700}}>{f.name}</p><p style={{fontSize:11,color:T.light}}>P:{f.p}g · C:{f.c}g · F:{f.f}g</p></div>
          <div style={{textAlign:"right"}}><p style={{fontSize:15,fontWeight:900,color:T.purple}}>{f.cal}</p><p style={{fontSize:10,color:T.light}}>kcal</p></div>
        </div>)}</>}
    </div>
  </div>;
}

/* ══════════════ AI CHAT SCREEN ══════════════ */
function AiChat({user,meals,toast,online=true}){
  const welcomeMsg=useMemo(()=>({role:"assistant",text:`Hi ${user?.name?.split(" ")[0]||"there"}! 👋 I'm your AI nutrition coach. Ask me anything about your diet, calories, macros, or health goals!`}),[user?.name]);
  const [messages,setMessages]=useState([]);
  const [historyLoading,setHistoryLoading]=useState(true);
  const [input,setInput]=useState("");
  const [sendLoading,setSendLoading]=useState(false);
  const bottomRef=useRef(null);
  const eaten=meals.reduce((a,m)=>a+m.cal,0);
  const sP=meals.reduce((a,m)=>a+m.p,0),sC=meals.reduce((a,m)=>a+m.c,0),sF=meals.reduce((a,m)=>a+m.f,0);

  useEffect(()=>{
    let cancel=false;
    (async()=>{
      if(!user?.token||!user?.id){
        if(!cancel){setMessages([welcomeMsg]);setHistoryLoading(false);}
        return;
      }
      try{
        const rows=await supa.select(user.token,"chat_messages","role,content,created_at",`&user_id=eq.${user.id}&order=created_at.desc&limit=20`);
        if(cancel)return;
        if(Array.isArray(rows)&&rows.length){
          const ordered=rows.slice().reverse().map(r=>({role:r.role,text:r.content}));
          setMessages(ordered);
        }else{
          setMessages([welcomeMsg]);
        }
      }catch(e){
        if(!cancel) setMessages([welcomeMsg]);
      }
      if(!cancel) setHistoryLoading(false);
    })();
    return()=>{cancel=true;};
  },[user?.id,user?.token,welcomeMsg]);

  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:"smooth"});},[messages,historyLoading,sendLoading]);

  const clearChat=async()=>{
    if(!user?.token||!user?.id){setMessages([welcomeMsg]);return;}
    try{
      await supa.del(user.token,"chat_messages",`user_id=eq.${user.id}`);
      setMessages([welcomeMsg]);
      toast("Chat cleared","✅");
    }catch(e){toast("Couldn't clear chat","❌");}
  };

  const send=async()=>{
    if(!online){toast("AI chat needs an internet connection.","📡");return;}
    const text=input.trim();
    if(!text||sendLoading||historyLoading)return;
    setInput("");
    const newMsgs=[...messages,{role:"user",text}];
    setMessages(newMsgs);
    setSendLoading(true);
    if(user?.token&&user?.id){
      try{await supa.insert(user.token,"chat_messages",{user_id:user.id,role:"user",content:text});}catch(e){}
    }
    try{
      const context=`User: ${user?.name}, Goal: ${user?.goal}, Weight: ${user?.weight}kg, Height: ${user?.height}cm, Activity: ${user?.activity}. Today's intake: ${eaten} kcal, Protein: ${sP}g, Carbs: ${sC}g, Fat: ${sF}g. Meals: ${meals.map(m=>m.name).join(", ")}.`;
      const system=`You are a friendly AI nutrition coach inside the NutriScan app. Be concise (2-4 sentences), warm, and practical. User context: ${context}`;
      const data=await aiComplete(user?.token,newMsgs.map(m=>({role:m.role,content:m.text})),system);
      const reply=data.content?.[0]?.text||"Sorry, I couldn't get a response. Try again!";
      setMessages(p=>[...p,{role:"assistant",text:reply}]);
      if(user?.token&&user?.id){
        try{await supa.insert(user.token,"chat_messages",{user_id:user.id,role:"assistant",content:reply});}catch(e){}
      }
    }catch(e){
      const friendly=formatAiErrorMessage(e);
      setMessages(p=>[...p,{role:"assistant",text:friendly}]);
      toast(friendly,"❌");
    }
    setSendLoading(false);
  };

  const QUICK=["What should I eat for lunch?","Am I hitting my protein goal?","How can I lose weight faster?","Is my calorie intake on track?"];

  return <div style={{display:"flex",flexDirection:"column",height:"100vh",paddingBottom:80}}>
    <div style={{padding:"16px 16px 12px",background:T.white,borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
      <div style={{maxWidth:600,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
          <div style={{width:42,height:42,borderRadius:14,background:`linear-gradient(135deg,${T.purple},${T.lav})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>🤖</div>
          <div style={{minWidth:0}}><p style={{fontSize:17,fontWeight:900}}>AI Nutrition Coach</p><p style={{fontSize:12,color:online?T.green:T.orange,fontWeight:700}}>{online?"● Online":"● Offline — AI unavailable"}</p></div>
        </div>
        <button type="button" className="btn-soft" style={{padding:"8px 12px",fontSize:12,flexShrink:0}} onClick={clearChat} disabled={!online||historyLoading}>Clear Chat</button>
      </div>
    </div>
    <div style={{flex:1,overflowY:"auto",padding:"16px",display:"flex",flexDirection:"column",gap:12,position:"relative"}}>
      {historyLoading&&<div style={{position:"absolute",inset:0,background:T.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12,zIndex:5}}>
        <div className="aSpin" style={{width:36,height:36,border:`3px solid ${T.lav}`,borderTop:`3px solid ${T.purple}`,borderRadius:"50%"}}/>
        <p style={{fontSize:13,fontWeight:700,color:T.mid}}>Loading chat…</p>
      </div>}
      <div style={{maxWidth:600,margin:"0 auto",width:"100%",display:"flex",flexDirection:"column",gap:12}}>
        {messages.map((m,i)=>(
          <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",gap:8,alignItems:"flex-end"}}>
            {m.role==="assistant"&&<div style={{width:30,height:30,borderRadius:10,background:`linear-gradient(135deg,${T.purple},${T.lav})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>🤖</div>}
            <div style={{maxWidth:"78%",padding:"11px 14px",borderRadius:m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px",background:m.role==="user"?T.navy:T.white,color:m.role==="user"?T.white:T.text,fontSize:14,fontWeight:500,lineHeight:1.5,boxShadow:`0 2px 8px ${T.shadow}`}}>
              {m.text}
            </div>
          </div>
        ))}
        {sendLoading&&<div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
          <div style={{width:30,height:30,borderRadius:10,background:`linear-gradient(135deg,${T.purple},${T.lav})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>🤖</div>
          <div style={{padding:"12px 16px",borderRadius:"18px 18px 18px 4px",background:T.white,boxShadow:`0 2px 8px ${T.shadow}`}}>
            <div style={{display:"flex",gap:4,alignItems:"center"}}>
              {[0,1,2].map(i=><div key={i} style={{width:7,height:7,borderRadius:"50%",background:T.lav,animation:`blink 1.2s ease ${i*0.2}s infinite`}}/>)}
            </div>
          </div>
        </div>}
        <div ref={bottomRef}/>
      </div>
    </div>
    {messages.length<=1&&online&&!historyLoading&&<div style={{padding:"0 16px 10px",flexShrink:0}}>
      <div style={{maxWidth:600,margin:"0 auto",display:"flex",gap:8,flexWrap:"wrap"}}>
        {QUICK.map(q=><button key={q} onClick={()=>{setInput(q);}} style={{padding:"8px 13px",borderRadius:20,background:T.lavBg,color:T.purple,border:`1.5px solid ${T.lav}`,fontFamily:"Nunito",fontSize:12,fontWeight:700,cursor:"pointer"}}>{q}</button>)}
      </div>
    </div>}
    {!online&&<div style={{padding:"0 16px 10px",flexShrink:0}}><p style={{fontSize:13,color:T.mid,fontWeight:600,textAlign:"center"}}>Connect to the internet to chat with the AI coach. Manual logging still works from Home → Scan → Manual.</p></div>}
    <div style={{padding:"10px 16px 12px",background:T.white,borderTop:`1px solid ${T.border}`,flexShrink:0}}>
      <div style={{maxWidth:600,margin:"0 auto",display:"flex",gap:10,alignItems:"center"}}>
        <input className="inp" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()} placeholder={online?"Ask your nutrition coach…":"Offline — AI unavailable"} style={{flex:1,background:T.bg,margin:0}} disabled={!online||historyLoading}/>
        <button onClick={send} disabled={!online||!input.trim()||sendLoading||historyLoading} style={{width:42,height:42,borderRadius:14,background:online&&input.trim()&&!sendLoading&&!historyLoading?T.navy:T.border,border:"none",cursor:online&&input.trim()&&!sendLoading&&!historyLoading?"pointer":"not-allowed",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"background .18s"}}>
          <svg width="18" height="18" fill="none" stroke={T.white} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  </div>;
}

/* ══════════════ BOTTOM NAV ══════════════ */
function BottomNav({active,setActive}){
  const tabs=[{id:"dashboard",label:"Home"},{id:"analytics",label:"Stats"},{id:"scanner",label:"Scan"},{id:"ai",label:"AI Chat"},{id:"settings",label:"Settings"}];
  const navRef=useRef(null);
  const iconRefs=useRef({});
  const [indicator,setIndicator]=useState({x:0,y:0,w:0,h:0,ready:false});

  const refreshIndicator=useCallback(()=>{
    const navEl=navRef.current;
    const activeIcon=iconRefs.current[active];
    if(!navEl||!activeIcon)return;
    const navRect=navEl.getBoundingClientRect();
    const iconRect=activeIcon.getBoundingClientRect();
    const next={
      x:iconRect.left-navRect.left,
      y:iconRect.top-navRect.top,
      w:iconRect.width,
      h:iconRect.height,
      ready:true
    };
    setIndicator(prev=>{
      const stable=Math.abs(prev.x-next.x)<0.5&&Math.abs(prev.y-next.y)<0.5&&Math.abs(prev.w-next.w)<0.5&&Math.abs(prev.h-next.h)<0.5&&prev.ready;
      return stable?prev:next;
    });
  },[active]);

  useLayoutEffect(()=>{
    refreshIndicator();
  },[refreshIndicator]);

  useEffect(()=>{
    const onResize=()=>refreshIndicator();
    window.addEventListener("resize",onResize);
    return()=>window.removeEventListener("resize",onResize);
  },[refreshIndicator]);

  useEffect(()=>{
    const raf=requestAnimationFrame(refreshIndicator);
    return()=>cancelAnimationFrame(raf);
  },[active,refreshIndicator]);

  const P={
    dashboard:<><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>,
    analytics:<><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></>,
    scanner:<><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></>,
    ai:<><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></>,
    settings:<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></>,
  };
  return <div className="bnav" ref={navRef}>
    <span
      className={`bnav-indicator${indicator.ready?" ready":""}`}
      style={{
        transform:`translate3d(${indicator.x}px,${indicator.y}px,0)`,
        width:indicator.w,
        height:indicator.h
      }}
    />
    {tabs.map(t=><button key={t.id} className={`nb${active===t.id?" active":""}`} onClick={()=>setActive(t.id)}><div className="nb-icon" ref={el=>{if(el)iconRefs.current[t.id]=el;}}><svg width="20" height="20" fill="none" stroke={active===t.id?T.white:T.light} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">{P[t.id]}</svg></div><span>{t.label}</span></button>)}
  </div>;
}

function buildInAppProgressNotifications({user,meals,water,streak}){
  if(!user)return[];
  const today=ymdLocal(new Date());
  const b=fBMR(user.gender,+user.weight,+user.height,+user.age);
  const tgt=fTarget(fTDEE(b,user.activity),user.goal);
  const {tP,tC,tF}=macroTargets(tgt);
  const eaten=meals.reduce((a,m)=>a+(+m.cal||0),0);
  const protein=meals.reduce((a,m)=>a+(+m.p||0),0);
  const carbs=meals.reduce((a,m)=>a+(+m.c||0),0);
  const fat=meals.reduce((a,m)=>a+(+m.f||0),0);
  const out=[];

  [3,7,14,30].forEach((m)=>{
    if(streak===m){
      out.push({id:`st-${m}-${today}`,e:"🔥",title:`${m}-day streak milestone!`,sub:`Great consistency — you've logged meals for ${m} days in a row.`,t:"Today"});
    }
  });

  if(meals.length>0&&eaten>=tgt*.95&&eaten<=tgt*1.05){
    out.push({id:`goal-hit-${today}`,e:"🎯",title:"You hit today's calorie target 🎯",sub:`${Math.round(eaten)} / ${tgt} kcal — right in the target zone.`,t:"Today"});
  }

  if(meals.length>0&&protein>=tP&&carbs>=tC&&fat>=tF){
    out.push({id:`macro-win-${today}`,e:"⚡",title:"Macro balance win!",sub:`Protein ${Math.round(protein)}g, Carbs ${Math.round(carbs)}g, Fat ${Math.round(fat)}g — all targets met.`,t:"Today"});
  }

  try{
    const last7=dateRangeInclusive(today,7);
    let bestDay={d:null,cal:0};
    let sum=0,days=0,waterGood=0,onTargetDays=0;
    for(const d of last7){
      const dayData=loadLocalDay(user.id,d);
      const dayMeals=Array.isArray(dayData?.meals)?dayData.meals:[];
      const dayWater=+dayData?.water||0;
      const dayCal=dayMeals.reduce((a,m)=>a+(+m.cal||0),0);
      if(dayCal>0){
        days++;
        sum+=dayCal;
        if(dayCal>bestDay.cal)bestDay={d,cal:dayCal};
        if(dayCal>=tgt*.95&&dayCal<=tgt*1.05)onTargetDays++;
      }
      if(dayWater>=8)waterGood++;
    }
    if(days>0){
      const avg=Math.round(sum/days);
      const bestLabel=bestDay?.d?new Date(bestDay.d+"T12:00:00").toLocaleDateString("en-IN",{weekday:"short"}):"—";
      out.push({id:`week-summary-${today}`,e:"📊",title:"Weekly summary",sub:`Best day: ${bestLabel} (${Math.round(bestDay.cal)} kcal) · Avg: ${avg} kcal · Water consistency: ${waterGood}/7 days.`,t:"This week"});

      const pbKey=`nutriscan_personal_bests_${user.id}`;
      let bests={longestStreak:0,bestOnTargetWeek:0};
      try{bests=JSON.parse(localStorage.getItem(pbKey)||"{}")||{};}catch(e){}
      let changed=false;
      if((streak||0)>(+bests.longestStreak||0)){
        bests.longestStreak=streak;
        changed=true;
        out.push({id:`pb-streak-${today}`,e:"🏆",title:"New personal best: longest streak",sub:`You've set a new best streak at ${streak} days.`,t:"Today"});
      }
      if(onTargetDays>(+bests.bestOnTargetWeek||0)){
        bests.bestOnTargetWeek=onTargetDays;
        changed=true;
        out.push({id:`pb-target-${today}`,e:"🌟",title:"New personal best: on-target week",sub:`${onTargetDays} on-target days in the last 7 days — your best so far.`,t:"This week"});
      }
      if(changed){
        try{localStorage.setItem(pbKey,JSON.stringify(bests));}catch(e){}
      }
    }
  }catch(e){}

  return out;
}

/* ══════════════ SPLASH SCREEN ══════════════ */
function SplashScreen(){
  const [progress,setProgress]=useState(0);
  const [phase,setPhase]=useState(0); // 0=logo, 1=tagline, 2=loading
  useEffect(()=>{
    const t1=setTimeout(()=>setPhase(1),600);
    const t2=setTimeout(()=>setPhase(2),1200);
    let start=null;
    let raf;
    const animate=ts=>{
      if(!start)start=ts;
      const elapsed=ts-start;
      const pct=Math.min(elapsed/2600,1); // 2.6s fill after phase2 starts (~1.2s in)
      setProgress(Math.round(pct*100));
      if(pct<1)raf=requestAnimationFrame(animate);
    };
    const t3=setTimeout(()=>{raf=requestAnimationFrame(animate);},1200);
    return()=>{clearTimeout(t1);clearTimeout(t2);clearTimeout(t3);cancelAnimationFrame(raf);};
  },[]);

  return <div style={{position:"fixed",inset:0,background:`linear-gradient(160deg,${T.navy} 0%,#2D2B4E 100%)`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:9999}}>
    {/* Floating food emojis */}
    {[{e:"🥗",s:{top:"8%",left:"8%"},d:"0s"},{e:"🍎",s:{top:"12%",right:"10%"},d:"1s"},{e:"🥑",s:{bottom:"20%",left:"6%"},d:"0.5s"},{e:"🍇",s:{bottom:"15%",right:"8%"},d:"1.5s"},{e:"🥦",s:{top:"30%",left:"4%"},d:"2s"},{e:"🍊",s:{top:"25%",right:"5%"},d:"0.8s"}].map((x,i)=>(
      <div key={i} style={{position:"absolute",fontSize:22,opacity:.15,animation:`float 4s ease-in-out infinite ${x.d}`,...x.s}}>{x.e}</div>
    ))}
    {/* Logo */}
    <div style={{animation:"popIn .5s cubic-bezier(.34,1.56,.64,1) both",textAlign:"center",marginBottom:48}}>
      <div style={{fontSize:72,marginBottom:16,filter:"drop-shadow(0 8px 24px rgba(123,111,191,.5))",animation:"float 3s ease-in-out infinite"}}>🥗</div>
      <h1 style={{fontSize:42,fontWeight:900,color:"#FFFFFF",lineHeight:1,letterSpacing:-1,opacity:phase>=0?1:0,transition:"opacity .4s"}}>NutriScan</h1>
      <p style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,.5)",letterSpacing:3,textTransform:"uppercase",marginTop:6,opacity:phase>=1?1:0,transition:"opacity .5s .1s"}}>AI · NUTRITION · WELLNESS</p>
    </div>
    {/* Progress bar */}
    <div style={{width:200,opacity:phase>=2?1:0,transition:"opacity .4s"}}>
      <div style={{height:3,borderRadius:2,background:"rgba(255,255,255,.12)",overflow:"hidden",marginBottom:12}}>
        <div style={{height:"100%",borderRadius:2,background:`linear-gradient(90deg,${T.purple},${T.lav})`,width:`${progress}%`,transition:"width .05s linear"}}/>
      </div>
      <p style={{textAlign:"center",fontSize:12,fontWeight:700,color:"rgba(255,255,255,.4)",letterSpacing:.5}}>Loading your nutrition data…</p>
    </div>
  </div>;
}

/* ══════════════ ROOT APP ══════════════ */
export default function App(){
  const DEFAULT_SETTINGS={mealReminders:true,waterReminders:true,sleepReminderEnabled:false,sleepReminderHour:22,sleepReminderMinute:30,healthInsights:true,achievementAlerts:true,darkMode:false,offline:true};
  const defaultDate=ymdLocal(new Date());
  const [splash,setSplash]=useState(true);   // 4s splash
  const [authReady,setAuthReady]=useState(false);
  const [screen,setScreen]=useState("landing");
  const [tab,setTab]=useState("dashboard");
  const [user,setUser]=useState(null);        // includes .token
  const [selectedDate,setSelectedDate]=useState(defaultDate);
  const [meals,setMeals]=useState([]);
  const [water,setWater]=useState(0);
  const [online,setOnline]=useState(()=>netOnline());
  const [showSrch,setShowSrch]=useState(false);
  const [showNot,setShowNot]=useState(false);
  const [showAch,setShowAch]=useState(false);
  const [mealStreak,setMealStreak]=useState(0);
  const [readNotifIds,setReadNotifIds]=useState(()=>new Set());
  const [settings,setSettings]=useState(()=>{try{return {...DEFAULT_SETTINGS,...(JSON.parse(localStorage.getItem("nutriscan_settings"))||{})};}catch(e){return DEFAULT_SETTINGS;}});
  const [soundFxEnabled,setSoundFxEnabled]=useState(()=>{try{return JSON.parse(localStorage.getItem("nutriscan_sound_fx")||"true");}catch(e){return true;}});
  const [firstSyncLoading,setFirstSyncLoading]=useState(false);
  const [signupInitialData,setSignupInitialData]=useState(null);
  const [syncingDate,setSyncingDate]=useState(null);
  const {toasts,add:toast}=useToasts();
  const prevMealStreakRef=useRef(0);
  const loadUserDataReqRef=useRef(0);
  const nonTodayEditWarnedRef=useRef(false);

  const warnNonTodayEditOnce=useCallback(()=>{
    const logDate=String(selectedDate||ymdLocal(new Date())).slice(0,10);
    const todayKey=ymdLocal(new Date());
    if(logDate===todayKey){
      nonTodayEditWarnedRef.current=false;
      return;
    }
    if(nonTodayEditWarnedRef.current)return;
    nonTodayEditWarnedRef.current=true;
    toast("ℹ️ You're modifying a non-today date. Changes will sync.","ℹ️");
  },[selectedDate,toast]);

  useEffect(()=>{
    const logDate=String(selectedDate||ymdLocal(new Date())).slice(0,10);
    if(logDate===ymdLocal(new Date()))nonTodayEditWarnedRef.current=false;
  },[selectedDate]);

  const playAppSfx=useCallback((name="success")=>playSfx(name,soundFxEnabled),[soundFxEnabled]);

  const theme=buildTheme(settings.darkMode);
  Object.assign(T,theme);
  const showSplash=splash||!authReady;

  const resolveStatusBarSpec=()=>{
    if(showSplash){
      return {bgColor:theme.bg,useTransparent:true,forceStyle:StatusBarStyle.Light};
    }
    if(screen==="landing"){
      return {bgColor:theme.bg,useTransparent:true,forceStyle:StatusBarStyle.Light};
    }
    if(screen==="signin"||screen==="signup"||screen==="forgot"){
      return {bgColor:theme.bg,useTransparent:false,forceStyle:settings.darkMode?StatusBarStyle.Light:StatusBarStyle.Dark};
    }
    if(screen==="app"&&tab==="ai"){
      const aiHeaderBg=settings.darkMode?"#1C1C2E":"#FFFFFF";
      return {bgColor:aiHeaderBg,useTransparent:false,forceStyle:settings.darkMode?StatusBarStyle.Light:StatusBarStyle.Dark};
    }
    return {bgColor:theme.bg,useTransparent:false,forceStyle:settings.darkMode?StatusBarStyle.Light:StatusBarStyle.Dark};
  };

  useEffect(()=>{try{localStorage.setItem("nutriscan_settings",JSON.stringify(settings));}catch(e){}},[settings]);
  useEffect(()=>{try{localStorage.setItem("nutriscan_sound_fx",JSON.stringify(soundFxEnabled));}catch(e){}},[soundFxEnabled]);
  useEffect(()=>{
    if(typeof document==="undefined")return;
    document.documentElement.style.colorScheme=settings.darkMode?"dark":"light";
    document.body.style.background=theme.bg;
    document.body.style.color=theme.text;
  },[settings.darkMode,theme.bg,theme.text]);

  useEffect(()=>{
    applyNativeStatusBar(resolveStatusBarSpec());
  },[showSplash,screen,tab,theme.bg,settings.darkMode]);

  /* ── Splash timer ── */
  useEffect(()=>{const t=setTimeout(()=>setSplash(false),4000);return()=>clearTimeout(t);},[]);

  /* ── Restore session on mount ── */
  useEffect(()=>{
    let active=true;
    const finishRestore=()=>{if(active)setAuthReady(true);};
    const goLanding=()=>{
      clearSession();
      if(!active)return;
      setUser(null);
      setSignupInitialData(null);
      setScreen("landing");
    };
    const restoreWatchdog=setTimeout(()=>{
      if(!active)return;
      goLanding();
      finishRestore();
    },12000);
    const restore=async()=>{
      let s=loadSession();
      if(typeof window!=="undefined"){
        try{
          const fromUrl=extractSessionFromUrl(window.location.href);
          if(fromUrl?.token){
            s=fromUrl;
            saveSession(s);
          }
          window.history.replaceState({},"",window.location.pathname+window.location.search);
        }catch(e){}
      }
      if(!s?.token){
        goLanding();
        finishRestore();
        return;
      }
      try{
        let token=s.token;
        if(s.refresh){
          const refreshed=await supa.refreshSession(s.refresh).catch(()=>null);
          if(refreshed?.access_token){
            token=refreshed.access_token;
            s={...s,token:refreshed.access_token,refresh:refreshed.refresh_token||s.refresh,user_id:refreshed.user?.id||s.user_id};
            saveSession(s);
          }
        }
        const u=await supa.getUser(token);
        const uid=u.id||u.user?.id;
        if((u.error||!uid)&&s.refresh){
          const refreshed=await supa.refreshSession(s.refresh).catch(()=>null);
          if(refreshed?.access_token){
            token=refreshed.access_token;
            s={...s,token:refreshed.access_token,refresh:refreshed.refresh_token||s.refresh,user_id:refreshed.user?.id||s.user_id};
            saveSession(s);
          }
        }
        const u2=await supa.getUser(token);
        const uid2=u2.id||u2.user?.id;
        if(u2.error||!uid2){
          goLanding();
          return;
        }
        const profile=await supa.select(token,"profiles","*",`&id=eq.${uid2}`);
        let p=Array.isArray(profile)&&profile[0];
        if(!p){
          const userEmail=u2.email||u2.user?.email||"";
          const meta=u2.user_metadata||u2.user?.user_metadata||{};
          const fallbackProfile={
            id:uid2,
            email:userEmail,
            name:String(meta.name||meta.full_name||userEmail.split("@")[0]||"User"),
            age:Number(meta.age)||28,
            gender:String(meta.gender||"male"),
            height:Number(meta.height)||170,
            weight:Number(meta.weight)||70,
            activity:String(meta.activity||"moderate"),
            goal:String(meta.goal||"loss"),
            onboarding_completed:false,
          };
          await supa.upsert(token,"profiles",fallbackProfile).catch(()=>null);
          const profileRetry=await supa.select(token,"profiles","*",`&id=eq.${uid2}`).catch(()=>null);
          p=Array.isArray(profileRetry)&&profileRetry[0] ? profileRetry[0] : fallbackProfile;
        }
        const authedUser={token,id:uid2,name:p.name,email:u2.email||u2.user?.email||p.email,profileImageUrl:String(p?.profile_image_url||""),lastAvatarUpdate:p?.last_avatar_update||null,age:String(p.age||28),gender:p.gender||"male",height:String(p.height||170),weight:String(p.weight||70),activity:p.activity||"moderate",goal:p.goal||"loss"};
        setUser(authedUser);
        setSignupInitialData(null);
        setScreen("app");
        await loadUserData(token,uid2);
      }catch(e){
        logAppError(e,"auth.restore_session");
        goLanding();
      }finally{
        clearTimeout(restoreWatchdog);
        finishRestore();
      }
    };
    restore();
    return()=>{active=false;clearTimeout(restoreWatchdog);};
  },[]);

  /* ── Capture native deep-link callback after OAuth ── */
  useEffect(()=>{
    let listener;
    const init=async()=>{
      try{
        listener=await CapacitorApp.addListener("appUrlOpen",async({url})=>{
          const sess=extractSessionFromUrl(url);
          if(!sess?.token)return;
          saveSession(sess);
          await Browser.close().catch(()=>{});
          if(typeof window!=="undefined")window.location.reload();
        });
      }catch(e){}
    };
    init();
    return()=>{listener?.remove();};
  },[]);

  /* ── Load meals/water local-first, then background-sync with Supabase ── */
  const loadUserData=async(token,uid,forDate)=>{
    const requestId=++loadUserDataReqRef.current;
    const dateKey=String(forDate||ymdLocal(new Date())).slice(0,10);
    setSyncingDate(dateKey);

    const localState=loadLocalDay(uid,dateKey);
    const localMeals=normalizeMealList(Array.isArray(localState.meals)?localState.meals:[]);
    const localWater=Number.isFinite(+localState.water)?+localState.water:0;
    if(requestId===loadUserDataReqRef.current){
      setMeals(localMeals);
      setWater(localWater);
    }

    if(!netOnline()||!token){
      if(requestId===loadUserDataReqRef.current)setSyncingDate(null);
      return;
    }

    try{
      const m=await supa.select(token,"meals","*",`&user_id=eq.${uid}&log_date=eq.${dateKey}&order=logged_at.asc`);
      const remoteMealsRaw=Array.isArray(m)&&m.length>0
        ?m.map(x=>({id:x.id,name:x.name,cal:x.calories,p:x.protein,c:x.carbs,f:x.fat,e:x.emoji,m:x.meal_type,t:new Date(x.logged_at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}))
        :[];
      const remoteMeals=normalizeMealList(remoteMealsRaw);
      const w=await supa.select(token,"water_logs","glasses",`&user_id=eq.${uid}&log_date=eq.${dateKey}`);
      const remoteWater=Array.isArray(w)&&w[0]?+w[0].glasses:0;

      if(requestId!==loadUserDataReqRef.current)return;

      const changed=!dayStateEquals(localMeals,localWater,remoteMeals,remoteWater);
      if(changed){
        setMeals(remoteMeals);
        setWater(remoteWater);
        saveLocalDay(uid,dateKey,remoteMeals,remoteWater);
      }

      const st=await supa.select(token,"settings","*",`&user_id=eq.${uid}`);
      if(requestId!==loadUserDataReqRef.current)return;
      if(Array.isArray(st)&&st[0]){
        const s=st[0];
        setSettings(prev=>({
          ...DEFAULT_SETTINGS,
          ...prev,
          mealReminders:s.meal_reminders,
          waterReminders:s.water_reminders,
          healthInsights:s.health_insights,
          achievementAlerts:s.achievement_alerts,
          darkMode:s.dark_mode,
          offline:s.offline_mode,
        }));
      }
    }catch(e){
      // Keep local-first state; sync failures should not block UI.
    }finally{
      if(requestId===loadUserDataReqRef.current)setSyncingDate(null);
    }
  };

  useEffect(()=>{
    if(screen!=="app"||!user?.id)return;
    const currentDate=String(selectedDate||ymdLocal(new Date())).slice(0,10);
    loadUserData(user.token,user.id,currentDate);
  },[screen,user?.id,user?.token,selectedDate]);

  /* ── Online / offline + sync queued manual changes to Supabase ── */
  useEffect(()=>{
    const on=async()=>{
      setOnline(true);
      if(user?.token){
        await flushOfflineQueue(user,toast);
        await loadUserData(user.token,user.id,selectedDate);
      }
    };
    const off=()=>setOnline(false);
    window.addEventListener("online",on);
    window.addEventListener("offline",off);
    return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};
  },[user?.token,user?.id,selectedDate]);

  useEffect(()=>{
    const onVisible=async()=>{
      if(document.visibilityState!=="visible")return;
      if(user?.token&&user?.id&&netOnline()){
        await flushOfflineQueue(user,toast);
        await loadUserData(user.token,user.id,selectedDate);
      }
    };
    document.addEventListener("visibilitychange",onVisible);
    return()=>document.removeEventListener("visibilitychange",onVisible);
  },[user?.token,user?.id,selectedDate,meals.length,water]);

  useEffect(()=>{
    if(!user?.id)return;
    const timer=setInterval(async()=>{
      const s=loadSession();
      if(!s?.refresh||!netOnline())return;
      try{
        const refreshed=await supa.refreshSession(s.refresh);
        if(refreshed?.access_token){
          saveSession({token:refreshed.access_token,refresh:refreshed.refresh_token||s.refresh,user_id:refreshed.user?.id||user.id});
          setUser(u=>u?{...u,token:refreshed.access_token}:u);
        }
      }catch(e){}
    },15*60*1000);
    return()=>clearInterval(timer);
  },[user?.id]);

  /* ── Meal streak for smart notifications ── */
  useEffect(()=>{
    if(!user?.token||!user?.id){setMealStreak(0);return;}
    let cancel=false;
    (async()=>{
      try{
        const today=ymdLocal(new Date());
        const streakStart=addDaysStr(today,-120);
        const streakRows=await supa.select(user.token,"meals","log_date",`&user_id=eq.${user.id}&log_date=gte.${streakStart}&order=log_date.asc`);
        const ds=new Set();
        if(Array.isArray(streakRows)) streakRows.forEach(r=>ds.add(r.log_date));
        if(!cancel) setMealStreak(computeMealStreak(ds,today));
      }catch(e){if(!cancel) setMealStreak(0);}
    })();
    return()=>{cancel=true;};
  },[user?.id,user?.token,meals]);

  const inAppNotifs=useMemo(()=>(user&&settings.achievementAlerts?buildInAppProgressNotifications({user,meals,water,streak:mealStreak}):[]),[user,settings.achievementAlerts,meals,water,mealStreak]);
  const notifications=useMemo(()=>inAppNotifs.map(n=>({...n,unread:!readNotifIds.has(n.id)})),[inAppNotifs,readNotifIds]);
  const hasUnreadNotifs=notifications.some(n=>n.unread);

  const openNotifs=useCallback(()=>{
    const raw=user&&settings.achievementAlerts?buildInAppProgressNotifications({user,meals,water,streak:mealStreak}):[];
    setReadNotifIds(prev=>{const n=new Set(prev);raw.forEach(x=>{if(x.id)n.add(x.id);});return n;});
    setShowNot(true);
  },[user,settings.achievementAlerts,meals,water,mealStreak]);
  const markAllNotifsRead=useCallback(()=>{
    const raw=user&&settings.achievementAlerts?buildInAppProgressNotifications({user,meals,water,streak:mealStreak}):[];
    setReadNotifIds(prev=>{const n=new Set(prev);raw.forEach(x=>{if(x.id)n.add(x.id);});return n;});
  },[user,settings.achievementAlerts,meals,water,mealStreak]);

  useEffect(()=>{
    if(screen!=="app"||!user?.id)return;
    const todayForSync=ymdLocal(new Date());
    if(selectedDate!==todayForSync)return;
    const eaten=meals.reduce((a,m)=>a+(+m.cal||0),0);
    const b=fBMR(user.gender,+user.weight,+user.height,+user.age);
    const calorieTarget=fTarget(fTDEE(b,user.activity),user.goal);
    const streakJustHit7=mealStreak===7;
    syncMealWaterReminders({
      mealReminders:settings.mealReminders,
      waterReminders:settings.waterReminders,
      sleepReminderEnabled:settings.sleepReminderEnabled,
      sleepReminderHour:settings.sleepReminderHour,
      sleepReminderMinute:settings.sleepReminderMinute,
      meals,
      water,
      caloriesEaten:eaten,
      calorieTarget:calorieTarget,
      currentStreak:mealStreak,
      streakJustHit7:streakJustHit7
    });
  },[screen,user?.id,settings.mealReminders,settings.waterReminders,settings.sleepReminderEnabled,settings.sleepReminderHour,settings.sleepReminderMinute,meals,water,mealStreak,user?.gender,user?.weight,user?.height,user?.age,user?.activity,user?.goal,selectedDate]);

  /* ── Persist water to Supabase (queue when offline) ── */
  const setWaterAndSave=async(val)=>{
    const prevWater=water;
    const v=typeof val==="function"?val(water):val;
    setWater(v);
    if(v>prevWater)playAppSfx("water");
    if(user?.id){
      const logDate=String(selectedDate||ymdLocal(new Date())).slice(0,10);
      if(logDate!==ymdLocal(new Date()))warnNonTodayEditOnce();
      saveLocalDay(user.id,logDate,meals,v);
    }
    if(!user?.token)return;
    const logDate=String(selectedDate||ymdLocal(new Date())).slice(0,10);
    const payload={user_id:user.id,glasses:v,log_date:logDate,updated_at:new Date().toISOString()};
    if(!netOnline()){enqueueOffline({kind:"water",payload});return;}
    try{await supa.upsert(user.token,"water_logs",payload);}catch(e){logAppError(e,"water_save_failed");enqueueOffline({kind:"water",payload});toast("Network issue — water log queued for sync","⚠️");}
  };

  /* ── Persist meals to Supabase (queue when offline) ── */
  const setMealsAndSave=async(updater)=>{
    const prev=meals;
    const next=typeof updater==="function"?updater(prev):updater;
    setMeals(next);
    if(next.length>prev.length)playAppSfx("success");
    if(user?.id){
      const logDate=String(selectedDate||ymdLocal(new Date())).slice(0,10);
      if(logDate!==ymdLocal(new Date()))warnNonTodayEditOnce();
      saveLocalDay(user.id,logDate,next,water);
    }
    if(!user?.token)return;
    const logDate=String(selectedDate||ymdLocal(new Date())).slice(0,10);
    const newMeals=next.filter(m=>!prev.find(p=>p.id===m.id));
    const removedMeals=prev.filter(m=>!next.find(n=>n.id===m.id));

    for(const rm of removedMeals){
      const payload={id:rm.id};
      if(!netOnline()){enqueueOffline({kind:"meal-delete",payload});continue;}
      try{await supa.del(user.token,"meals",`id=eq.${encodeURIComponent(rm.id)}&user_id=eq.${user.id}`);}catch(e){logAppError(e,"meal_delete_failed");enqueueOffline({kind:"meal-delete",payload});toast("Network issue — meal delete queued for sync","⚠️");}
    }

    const idMap=new Map();
    for(const m of newMeals){
      const payload={user_id:user.id,name:m.name,calories:m.cal,protein:m.p||0,carbs:m.c||0,fat:m.f||0,emoji:m.e||"🍽️",meal_type:m.m||"Snack",log_date:logDate};
      if(!netOnline()){enqueueOffline({kind:"meal",payload});continue;}
      try{
        const inserted=await supa.insert(user.token,"meals",payload);
        const row=Array.isArray(inserted)?inserted[0]:null;
        if(row?.id!=null)idMap.set(m.id,row.id);
      }catch(e){logAppError(e,"meal_save_failed");enqueueOffline({kind:"meal",payload});toast("Network issue — meal queued for sync","⚠️");}
    }
    if(idMap.size){
      setMeals(cur=>cur.map(it=>idMap.has(it.id)?{...it,id:idMap.get(it.id)}:it));
    }
  };

  /* ── Persist settings to Supabase (queue when offline) ── */
  const setSetting=async(k,v)=>{
    setSettings(p=>{
      const next={...p,[k]:v};
      if(user?.token){
        const payload={user_id:user.id,meal_reminders:next.mealReminders,water_reminders:next.waterReminders,health_insights:next.healthInsights,achievement_alerts:next.achievementAlerts,dark_mode:next.darkMode,offline_mode:next.offline,updated_at:new Date().toISOString()};
        if(!netOnline())enqueueOffline({kind:"settings",payload});
        else supa.upsert(user.token,"settings",payload).catch((e)=>{logAppError(e,"settings_save_failed");enqueueOffline({kind:"settings",payload});toast("Network issue — settings queued for sync","⚠️");});
      }
      return next;
    });
  };

  const parseTimeLabelToMinutes=(label)=>{
    const txt=String(label||"").trim();
    const ampm=txt.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
    if(ampm){
      let h=Math.max(0,Math.min(23,+ampm[1]||0));
      const m=Math.max(0,Math.min(59,+ampm[2]||0));
      const suffix=ampm[3].toLowerCase();
      if(suffix==="pm"&&h<12)h+=12;
      if(suffix==="am"&&h===12)h=0;
      return h*60+m;
    }
    const h24=txt.match(/^(\d{1,2}):(\d{2})$/);
    if(h24){
      const h=Math.max(0,Math.min(23,+h24[1]||0));
      const m=Math.max(0,Math.min(59,+h24[2]||0));
      return h*60+m;
    }
    return null;
  };

  const isLikelyDuplicateScannerMeal=(candidate)=>{
    if(!candidate)return false;
    const candidateName=String(candidate.name||"").trim().toLowerCase();
    const candidateCal=Math.round(Number(candidate.cal||0));
    const candidateMealType=String(candidate.m||"").trim().toLowerCase();
    const now=new Date();
    const nowMins=now.getHours()*60+now.getMinutes();
    return meals.some(existing=>{
      if(String(existing.name||"").trim().toLowerCase()!==candidateName)return false;
      if(Math.round(Number(existing.cal||0))!==candidateCal)return false;
      if(candidateMealType&&String(existing.m||"").trim().toLowerCase()!==candidateMealType)return false;
      const existingMins=parseTimeLabelToMinutes(existing.t);
      if(existingMins==null)return true;
      const delta=Math.abs(existingMins-nowMins);
      return delta<=15;
    });
  };

  const onScannerAddMeal=(meal)=>{
    if(isLikelyDuplicateScannerMeal(meal)){
      toast("ℹ️ You just logged this meal. Add again if intentional.","❓");
      return;
    }
    setMealsAndSave(p=>[...p,meal]);
  };

  useEffect(()=>{
    const prev=prevMealStreakRef.current||0;
    const cur=mealStreak||0;
    if(cur>prev&&settings.achievementAlerts&&[3,7,14,30].includes(cur)){
      playAppSfx("achievement");
    }
    prevMealStreakRef.current=cur;
  },[mealStreak,settings.achievementAlerts,playAppSfx]);

  /* ── Auth handlers ── */
  const handleAuth=async(u)=>{
    setUser(u);
    setSignupInitialData(null);
    setScreen("app");
    if(u?.token){
      const s=loadSession()||{};
      saveSession({token:u.token,refresh:u.refresh||s.refresh||"",user_id:u.id});
    }
    toast(`Welcome, ${u.name}! 🎉`,"👋");
    if(u.token)await loadUserData(u.token,u.id,selectedDate);
    try{
      const firstKey=`nutriscan_first_login_setup_${u.id}`;
      if(!localStorage.getItem(firstKey)){
        setFirstSyncLoading(true);
        await new Promise(r=>setTimeout(r,1400));
        const b=fBMR(u.gender,+u.weight,+u.height,+u.age);
        const target=fTarget(fTDEE(b,u.activity),u.goal);
        toast(`Your daily calorie target is ${target} kcal`,"🎯");
        localStorage.setItem(firstKey,"1");
        setFirstSyncLoading(false);
      }
    }catch(e){setFirstSyncLoading(false);}
  };

  const signOut=async()=>{
    if(user?.token)await supa.signOut(user.token).catch(()=>{});
    clearSession();
    writeOfflineQueue([]);
    setScreen("landing");setTab("dashboard");setUser(null);
    setSelectedDate(ymdLocal(new Date()));
    setMeals([]);setWater(0);
    setSettings({mealReminders:true,waterReminders:true,healthInsights:true,achievementAlerts:true,darkMode:false,offline:true});
  };

  return <>
    <style>{CSS}</style>
    <style>{buildThemeCSS(theme)}</style>
    {showSplash&&<SplashScreen/>}
    <div className="shell" style={{background:T.bg,color:T.text,opacity:showSplash?0:1,transition:"opacity .4s"}}>
      {authReady&&screen==="landing" && <Landing onSignIn={()=>setScreen("signin")} onSignUp={()=>setScreen("signup")}/>}
      {authReady&&screen==="signin"  && <SignIn  onSuccess={handleAuth} onSignUp={()=>setScreen("signup")} onForgot={()=>setScreen("forgot")}/>}
      {authReady&&screen==="signup"  && <SignUp  onSuccess={handleAuth} onSignIn={()=>setScreen("signin")} initialData={signupInitialData}/>}
      {authReady&&screen==="forgot"  && <ForgotPassword onBack={()=>setScreen("signin")}/>}
      {authReady&&screen==="app"&&user&&<>
        {firstSyncLoading&&<div style={{position:"fixed",inset:0,zIndex:9998,background:"rgba(20,20,35,.45)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div className="card" style={{maxWidth:340,textAlign:"center"}}>
            <div className="aSpin" style={{width:36,height:36,border:`3px solid ${T.lav}`,borderTop:`3px solid ${T.purple}`,borderRadius:"50%",margin:"0 auto 12px"}}/>
            <p style={{fontSize:16,fontWeight:800,marginBottom:6}}>Setting up your plan…</p>
            <p style={{fontSize:12,color:T.mid,fontWeight:600}}>Calculating your personalized daily calorie target</p>
          </div>
        </div>}
        {!online&&<div style={{position:"sticky",top:0,zIndex:150,background:T.peachBg,color:T.text,padding:"8px 16px",textAlign:"center",fontSize:13,fontWeight:700,boxShadow:`0 2px 8px ${T.shadow}`}}>📡 Offline — manual logs & water are saved here and sync when you&apos;re back online.</div>}
        {showSrch&&<SearchScreen meals={meals} onClose={()=>setShowSrch(false)} toast={(m,i)=>toast(m,i||"✅")}/>}
        {showNot&&<NotificationsSheet notifications={notifications} onClose={()=>setShowNot(false)} toast={toast} onMarkAllRead={markAllNotifsRead}/>}
        {showAch&&<div className="overlay" onClick={e=>{if(e.target===e.currentTarget)setShowAch(false);}}><div className="sheet"><div className="sheet-handle"/><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}><p style={{fontSize:18,fontWeight:900}}>🏆 Achievements</p><button onClick={()=>setShowAch(false)} className="btn-icon" style={{width:32,height:32,borderRadius:10}}>{Ic.x}</button></div><Achievements user={user} toast={(m,i)=>toast(m,i||"✅")} inline/></div></div>}
        <div style={{height:"100vh",overflowY:"auto",width:"100%"}}>
          {tab==="dashboard"    && <Dashboard    user={user} setUser={setUser} meals={meals} setMeals={setMealsAndSave} water={water} setWater={setWaterAndSave} toast={(m,i)=>toast(m,i||"✅")} setTab={setTab} showSearch={()=>setShowSrch(true)} openNotifs={openNotifs} hasUnreadNotifs={hasUnreadNotifs} showAwards={()=>setShowAch(true)} playSfx={playAppSfx} selectedDate={selectedDate} onSelectDate={setSelectedDate} isSyncingDate={syncingDate}/>}
          {tab==="scanner"      && <Scanner      onAddMeal={onScannerAddMeal} toast={(m,i)=>toast(m,i||"✅")} user={user} online={online} playSfx={playAppSfx}/>}
          {tab==="analytics"    && <Analytics    user={user}/>}
          {tab==="ai"           && <AiChat       user={user} meals={meals} toast={(m,i)=>toast(m,i||"✅")} online={online}/>}
          {tab==="settings"     && <Settings     user={user} setUser={setUser} toast={(m,i)=>toast(m,i||"✅")} onSignOut={signOut} settings={settings} setSetting={setSetting} meals={meals} onDataCleared={()=>{setMeals([]);setWater(0);if(user?.id){const prefix=`nutriscan_local_${user.id}_`;try{const keys=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key&&(key.startsWith(prefix)||key.includes(`nutriscan_sport_${user.id}`))){keys.push(key);}}for(const k of keys)localStorage.removeItem(k);}catch(e){}}writeOfflineQueue([]);}} soundFxEnabled={soundFxEnabled} setSoundFxEnabled={setSoundFxEnabled} playSfx={playAppSfx} online={online} aiConfigured={!!OPENROUTER_KEY}/>}
        </div>
        <BottomNav active={tab} setActive={setTab}/>
      </>}
    </div>
    <Toasts toasts={toasts}/>
  </>;
}
