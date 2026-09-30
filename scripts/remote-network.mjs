import http from 'node:http';
import {execFile} from 'node:child_process';
import {isIP} from 'node:net';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
const invalidProxy=()=>Error('远程代理配置无效；仅支持完整的 HTTP(S) 代理地址，请检查配置（代理值不会写入日志）');

function proxyURL(value){
 if(typeof value!=='string'||value.length>16384||/[\s\u0000-\u001f\u007f\\]/.test(value))throw invalidProxy();
 if(value==='')return value;
 let url;try{url=new URL(value);}catch{throw invalidProxy();}
 if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.hash||url.search||url.pathname!=='/'||url.port==='0')throw invalidProxy();
 return value;
}
function environmentValue(env,upper){
 const lower=upper.toLowerCase();
 return env[lower]!==undefined?env[lower]:env[upper];
}
export function environmentProxy(env){
 if(env.NODE_USE_ENV_PROXY==='0')return {source:'disabled',proxyEnv:null};
 const proxyEnv={};let explicit=false;
 for(const name of ['HTTP_PROXY','HTTPS_PROXY']){
  const value=environmentValue(env,name);
  if(value!==undefined){explicit=true;proxyEnv[name]=proxyURL(value);}
 }
 const noProxy=environmentValue(env,'NO_PROXY');
 if(noProxy!==undefined){if(typeof noProxy!=='string'||noProxy.length>16384||/[\u0000-\u001f\u007f]/.test(noProxy))throw invalidProxy();proxyEnv.NO_PROXY=noProxy;}
 if(noProxy?.trim()==='*')return {source:'disabled',proxyEnv:null};
 if(!explicit&&environmentValue(env,'ALL_PROXY'))throw Error('当前环境仅配置了未受支持的通用代理；请显式设置 HTTP_PROXY 或 HTTPS_PROXY');
 return {source:explicit?'environment':null,proxyEnv};
}

export function parseMacOSHTTPSProxy(output){
 if(typeof output!=='string'||output.length>65536)throw Error('无法解析 macOS 代理设置');
 const fields={};let depth=0,rootSeen=false;
 for(const raw of output.split(/\r?\n/)){
  const line=raw.trim();
  if(line==='<dictionary> {'&&depth===0&&!rootSeen){rootSeen=true;depth=1;continue;}
  if(depth>0&&/:\s*<(?:dictionary|array)>\s*\{$/.test(line)){depth++;continue;}
  if(line==='}'){if(depth===0)throw Error('无法解析 macOS 代理设置');depth--;continue;}
  if(depth!==1)continue;
  const match=/^(HTTPSEnable|HTTPSProxy|HTTPSPort)\s*:\s*(.*?)\s*$/.exec(line);
  if(match){if(Object.hasOwn(fields,match[1]))throw Error('无法解析 macOS 代理设置');fields[match[1]]=match[2];}
 }
 if(!rootSeen||depth!==0)throw Error('无法解析 macOS 代理设置');
 if(fields.HTTPSEnable===undefined||fields.HTTPSEnable==='0')return null;
 const host=fields.HTTPSProxy,port=fields.HTTPSPort;
 const ipv4=typeof host==='string'&&isIP(host)===4&&host.split('.')[0]==='127';
 if(fields.HTTPSEnable!=='1'||!['localhost','::1','[::1]'].includes(host)&&!ipv4||typeof port!=='string'||!/^[1-9]\d{0,4}$/.test(port)||Number(port)>65535)throw Error('macOS HTTPS 代理不符合本机回环地址和端口要求；请显式配置受支持的代理或禁用自动发现');
 return `http://${host==='::1'?'[::1]':host}:${port}`;
}

async function readMacOSProxy(){
 try{return (await execFileAsync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:2000,maxBuffer:65536})).stdout;}
 catch{throw Error('无法读取 macOS 代理设置；请显式配置代理或用 NODE_USE_ENV_PROXY=0 禁用自动发现');}
}

export async function configureRemoteNetwork({env=process.env,platform=process.platform,readSystemProxy=readMacOSProxy,setGlobalProxyFromEnv=http.setGlobalProxyFromEnv}={}){
 const selected=environmentProxy(env);
 if(selected.source==='disabled')return {source:'disabled'};
 let {source,proxyEnv}=selected;
 if(!source){
  if(platform!=='darwin')return {source:'direct'};
  const systemProxy=parseMacOSHTTPSProxy(await readSystemProxy());
  if(!systemProxy)return {source:'direct'};
  source='macos';proxyEnv={...proxyEnv,HTTPS_PROXY:systemProxy};
 }
 if(!proxyEnv.HTTP_PROXY&&!proxyEnv.HTTPS_PROXY)return {source:'direct'};
 if(typeof setGlobalProxyFromEnv!=='function')throw Error('远程连接需要代理；当前 Node 不支持动态代理，请升级至 Node 24.14+、25.4+ 或更新主版本后重试');
 try{setGlobalProxyFromEnv(proxyEnv);}catch{throw Error('远程代理初始化失败；请检查代理配置（代理值不会写入日志）');}
 return {source};
}
