import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {configureRemoteNetwork,environmentProxy,parseMacOSHTTPSProxy} from '../scripts/remote-network.mjs';
import {remoteMain} from '../scripts/remote-organizer.mjs';

const scutil=(host='127.0.0.1',port='8123',enabled='1')=>`<dictionary> {
 HTTPSEnable : ${enabled}
 HTTPSProxy : ${host}
 HTTPSPort : ${port}
 SOCKSEnable : 1
 SOCKSProxy : unrelated.example
 SOCKSPort : 9999
}`;
const fail=()=>assert.fail('must not be called');

test('explicit environment proxy wins over macOS; lower-case fields win and NO_PROXY is preserved',async()=>{
 const env={HTTP_PROXY:'http://upper.example:8000',http_proxy:'http://lower.example:8001',HTTPS_PROXY:'https://upper.example:8002',https_proxy:'http://user:private-password@lower.example:8003',NO_PROXY:'wrong.example',no_proxy:'localhost,.internal.example',UNRELATED_SECRET:'never-copy'},original={...env};let received;
 const result=await configureRemoteNetwork({env,platform:'darwin',readSystemProxy:fail,setGlobalProxyFromEnv:value=>{received=value;}});
 assert.deepEqual(received,{HTTP_PROXY:env.http_proxy,HTTPS_PROXY:env.https_proxy,NO_PROXY:env.no_proxy});
 assert.deepEqual(result,{source:'environment'});assert.deepEqual(env,original);assert(!JSON.stringify(result).includes('private-password'));
});
test('explicit disable, no-proxy-all and empty proxy settings do not discover or configure system proxies',async()=>{
 for(const env of [{NODE_USE_ENV_PROXY:'0',HTTPS_PROXY:'invalid-secret'},{NO_PROXY:'*'},{HTTPS_PROXY:''},{https_proxy:'',HTTPS_PROXY:'http://ignored.example:8000'}])await configureRemoteNetwork({env,platform:'darwin',readSystemProxy:fail,setGlobalProxyFromEnv:fail});
});
test('only macOS enabled HTTPS loopback proxies are discovered, without a hardcoded port',async()=>{
 for(const host of ['localhost','127.0.0.1','127.22.33.44','::1','[::1]'])assert.equal(parseMacOSHTTPSProxy(scutil(host,'65432')),`http://${host==='::1'?'[::1]':host}:65432`);
 for(const value of [scutil('not-used.example','0','0'),'<dictionary> {\n SOCKSEnable : 1\n SOCKSProxy : localhost\n SOCKSPort : 8123\n}','<dictionary> {\n ProxyAutoConfigEnable : 1\n ProxyAutoConfigURLString : https://example.invalid/proxy.pac\n}'])assert.equal(parseMacOSHTTPSProxy(value),null);
 let received;const result=await configureRemoteNetwork({env:{no_proxy:'localhost,.example'},platform:'darwin',readSystemProxy:async()=>scutil('::1','8345'),setGlobalProxyFromEnv:value=>{received=value;}});
 assert.deepEqual(result,{source:'macos'});assert.deepEqual(received,{NO_PROXY:'localhost,.example',HTTPS_PROXY:'http://[::1]:8345'});
 assert.deepEqual(await configureRemoteNetwork({env:{},platform:'linux',readSystemProxy:fail,setGlobalProxyFromEnv:fail}),{source:'direct'});
});
test('macOS parser ignores scoped proxies and rejects non-loopback, duplicate and malicious settings without echoing values',()=>{
 assert.equal(parseMacOSHTTPSProxy('<dictionary> {\n __SCOPED__ : <dictionary> {\n en0 : <dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : evil.example\n HTTPSPort : 9000\n }\n }\n}'),null);
 for(const host of ['proxy.example','192.168.1.20','127.0.0.1.evil.example','localhost@evil.example','http://localhost','localhost;secret-command','127.1','0x7f000001','[::ffff:127.0.0.1]'])assert.throws(()=>parseMacOSHTTPSProxy(scutil(host)),error=>!error.message.includes(host));
 for(const port of ['0','65536','-1','1.5','8123/private-secret'])assert.throws(()=>parseMacOSHTTPSProxy(scutil('localhost',port)),error=>!error.message.includes(port));
 assert.throws(()=>parseMacOSHTTPSProxy(scutil().replace(' HTTPSEnable : 1',' HTTPSEnable : 1\n HTTPSEnable : 0')),/解析/);
});
test('environment proxy validation and initialization failures never echo proxy credentials',async()=>{
 for(const proxy of ['socks5://user:private-password@localhost:8000','http://localhost:8000/private-password','http://localhost:8000?private-password','http://localhost:8000#private-password','http://localhost\\@private-password.example:8000','http://localhost:8000\nprivate-password','http://localhost:0'])assert.throws(()=>environmentProxy({HTTPS_PROXY:proxy}),error=>!error.message.includes('private-password')&&!error.message.includes(proxy));
 await assert.rejects(()=>configureRemoteNetwork({env:{HTTPS_PROXY:'http://user:private-password@proxy.example:8000'},setGlobalProxyFromEnv:()=>{throw Error('private-password');}}),error=>!error.message.includes('private-password')&&error.message.includes('初始化失败'));
 assert.throws(()=>environmentProxy({ALL_PROXY:'socks5://private-password@localhost:8000'}),error=>!error.message.includes('private-password')&&error.message.includes('HTTP_PROXY'));
});
test('capability boundary requires the dynamic API only when a proxy is needed; older direct runtimes remain usable',async()=>{
 for(const version of ['22.13','24.13','25.3']){
  const options={platform:'linux',setGlobalProxyFromEnv:null};
  assert.deepEqual(await configureRemoteNetwork({...options,env:{}}),{source:'direct'},version);
  await assert.rejects(()=>configureRemoteNetwork({...options,env:{HTTPS_PROXY:'http://localhost:8123'}}),/Node 24\.14\+、25\.4\+/);
 }
 for(const version of ['24.14','25.4','26.0']){let calls=0;await configureRemoteNetwork({env:{HTTPS_PROXY:'http://localhost:8123'},platform:'linux',setGlobalProxyFromEnv:()=>{calls++;}});assert.equal(calls,1,version);}
 assert.deepEqual(await configureRemoteNetwork({env:{},platform:'darwin',readSystemProxy:async()=>scutil('unused','0','0'),setGlobalProxyFromEnv:null}),{source:'direct'});
 await assert.rejects(()=>configureRemoteNetwork({env:{},platform:'darwin',readSystemProxy:async()=>scutil(),setGlobalProxyFromEnv:null}),/升级/);
});
test('remote CLI prepares networking only before a real fetch, not help/init/prune or mock requests',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'liubai-network-test-')),cfg={url:'https://liubai.example',sitesToken:'s'.repeat(32),agentToken:'a'.repeat(32),backupKey:randomBytes(32).toString('base64')};
 const common={root,print:()=>{},configureNetwork:fail};
 await remoteMain(['help'],common);await remoteMain(['prune'],common);
 await remoteMain(['init'],{...common,input:Readable.from([JSON.stringify(cfg)])});
 await remoteMain(['queue'],{...common,fetchImpl:async()=>Response.json({accounts:[]})});
 let prepared=0;await assert.rejects(()=>remoteMain(['queue'],{...common,configureNetwork:async()=>{prepared++;throw Error('stop before real fetch');}}),/stop before real fetch/);assert.equal(prepared,1);
});
