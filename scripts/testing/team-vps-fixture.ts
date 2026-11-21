import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_IMAGE_DIGEST, CUA_DRIVER_VERSION, IMAGE, IMAGE_LAYER_VERSION } from "../../server/container-computer.ts";
import { fakeDesktopFrame } from "./fake-desktop-frame.ts";
import { fakeVnc } from "./fake-vnc.ts";

export async function createTeamVpsFixture(options: { frames?: boolean; missingInitially?: boolean; hold?: string; screens?: boolean; holdScreenshots?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "madani-team-vps-fixture-"));
  const binDir = join(directory, "bin");
  const records = join(directory, "computers");
  const screenRecords = join(directory, "screens");
  mkdirSync(binDir);
  mkdirSync(records);
  mkdirSync(screenRecords);
  const desktop = await fakeVnc();
  const calls = join(directory, "docker-calls.jsonl");
  const sshCalls = join(directory, "ssh-calls.jsonl");
  const hold = options.hold ?? join(directory, "docker.hold");
  const screenshotHold = join(directory, "screenshot.hold");
  const frame = join(directory, "frame.b64");
  writeFileSync(calls, "");
  writeFileSync(sshCalls, "");
  writeFileSync(frame, fakeDesktopFrame(0, 1).toString("base64"));
  writeFileSync(join(binDir, "docker"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DOCKER_NAMES } = require(${JSON.stringify(fileURLToPath(new URL("../../electron/legacy-names.mjs", import.meta.url)))});
const records = ${JSON.stringify(records)};
const screens = ${JSON.stringify(screenRecords)};
let args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if (fs.existsSync(${JSON.stringify(hold)})) {
  fs.writeFileSync(${JSON.stringify(`${hold}.started`)},String(process.pid));
  while(fs.existsSync(${JSON.stringify(hold)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
}
if (args[0] === '-H') args = args.slice(2);
if (${JSON.stringify(options.holdScreenshots === true)} && args[0] === 'exec' && args.includes('get_desktop_state') && fs.existsSync(${JSON.stringify(screenshotHold)})) {
  fs.appendFileSync(${JSON.stringify(`${screenshotHold}.started`)},JSON.stringify(args)+'\\n');
  while(fs.existsSync(${JSON.stringify(screenshotHold)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
}
const image = 'sha256:' + 'a'.repeat(64);
const labels = {[DOCKER_NAMES.label('local-vm')]:'1',[DOCKER_NAMES.label('cua-driver')]:${JSON.stringify(CUA_DRIVER_VERSION)},
  [DOCKER_NAMES.label('cua-base')]:${JSON.stringify(BASE_IMAGE_DIGEST)},[DOCKER_NAMES.label('image-layer')]:${JSON.stringify(IMAGE_LAYER_VERSION)}};
const rows = () => fs.readdirSync(records).map(name => JSON.parse(fs.readFileSync(path.join(records,name),'utf8')));
const save = row => fs.writeFileSync(path.join(records,row.Id+'.json'),JSON.stringify(row));
const make = name => ({Id:crypto.createHash('sha256').update(name).digest('hex'),Name:'/'+name,Image:image,
  Config:{Image:${JSON.stringify(IMAGE)},Env:['VNC_PW=fixture-only'],Labels:{...labels,[DOCKER_NAMES.label('vps')]:'1',[DOCKER_NAMES.label('container')]:name,[DOCKER_NAMES.label('vps-viewer')]:'1'}},
  State:{Running:true,Status:'running'},Mounts:[],
  HostConfig:{Binds:[],VolumesFrom:[],NetworkMode:'bridge',PortBindings:{},PublishAllPorts:false,Memory:4294967296,MemorySwap:4294967296,
    NanoCpus:2000000000,PidsLimit:4096,CapDrop:['ALL'],CapAdd:['CAP_SETUID','CAP_SETGID'],Privileged:false,PidMode:'',IpcMode:'private',
    UTSMode:'',ShmSize:536870912,Devices:[],DeviceRequests:[],SecurityOpt:[],UsernsMode:'',CgroupnsMode:'private',
    OomKillDisable:false,AutoRemove:false,RestartPolicy:{Name:'unless-stopped',MaximumRetryCount:0}},
  NetworkSettings:{Networks:{bridge:{IPAddress:'172.17.0.5'}}}});
const find = ref => rows().find(row => row.Id === ref || row.Name === '/'+ref);
const missing = () => {process.stderr.write('No such container');process.exit(1)};
const screenshot = () => {
  if (!${JSON.stringify(options.frames === true)}) return fs.readFileSync(${JSON.stringify(frame)},'utf8');
  const row=find(args.find(value=>/^[a-f0-9]{64}$/.test(value)));
  if(!row)missing();
  row.captureTick=(row.captureTick||0)+1;save(row);
  return require(${JSON.stringify(fileURLToPath(new URL("./fake-desktop-frame.ts", import.meta.url)))}).fakeDesktopFrame(parseInt(row.Id.slice(0,6),16),row.captureTick).toString('base64');
};
let out;
if (args[0] === 'image' && args[1] === 'inspect') out = [{Id:image,Config:{Labels:labels}}];
else if (args[0] === 'inspect') {
  const name = args[1];
  if (!new RegExp('^'+DOCKER_NAMES.vpsPrefix+'-[a-z0-9-]+$').test(name)) missing();
  const row = find(name) || (${JSON.stringify(options.missingInitially === true)} ? missing() : make(name));save(row);out = [row];
} else if (args[0] === 'run') {
  const name=args[args.indexOf('--name')+1];
  if(!name || !new RegExp('^'+DOCKER_NAMES.vpsPrefix+'-[a-z0-9-]+$').test(name))missing();
  const row=make(name);save(row);out=row.Id;
} else if (args[0] === 'container' && args[1] === 'ls') out = rows().map(row => row.Id).join('\\n');
else if (args[0] === 'container' && args[1] === 'inspect') {out=args.slice(2).map(find);if(out.some(row=>!row))missing();}
else if (['start','stop','rm'].includes(args[0])) {
  const row=find(args.at(-1));if(!row)missing();
  if(args[0]==='rm')fs.unlinkSync(path.join(records,row.Id+'.json'));
  else {row.State={Running:args[0]==='start',Status:args[0]==='start'?'running':'exited'};save(row);}out='';
} else if (args[0] === 'exec') {
  const controller=args.indexOf('/usr/local/bin/omb-screen');
  if(controller>=0) {
    if(!${JSON.stringify(options.screens === true)}){process.stderr.write('omb-screen: no such file');process.exit(127);}
    const action=args[controller+1], display=Number(args[controller+2]), botHash=args[controller+3], generation=args[controller+4];
    const file=path.join(screens,display+'.json');
    const current=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
    const valid=()=>{const row=current();return row?.botHash===botHash && row?.generation===generation;};
    if(action==='version')out={version:2,displays:Array.from({length:20},(_,i)=>i+2)};
    else if(action==='reset'){for(const name of fs.readdirSync(screens))fs.unlinkSync(path.join(screens,name));out={};}
    else if(action==='ensure') {
      if(!Number.isInteger(display) || display<2 || display>21 || !/^[a-f0-9]{64}$/.test(botHash) || !/^[a-f0-9-]{36}$/.test(generation))process.exit(64);
      out={version:2,ready:true,display,botHash,generation};fs.writeFileSync(file,JSON.stringify(out));
    } else if(action==='stop'){if(fs.existsSync(path.join(path.dirname(screens),'screen-stop-fail'))){process.stderr.write('fixture screen stop failed');process.exit(1);}if(valid())fs.unlinkSync(file);out={};}
    else if(action==='browser-close'){if(!valid())process.exit(1);out={...current(),browserClosed:true};fs.writeFileSync(file,JSON.stringify(out));}
    else if(action==='browser-ensure'){if(!valid())process.exit(1);out={...current(),browserClosed:false};fs.writeFileSync(file,JSON.stringify(out));}
    else if(action==='check'){if(!valid())process.exit(1);out={ready:true};}
    else if(action==='relay') {
      if(!valid())process.exit(1);
      let request='';process.stdin.on('data',chunk=>{request+=chunk;if(!request.includes('\\r\\n\\r\\n'))return;
        const body=JSON.stringify(request.includes('/json/version')?{Browser:'Fixture Chromium','webSocketDebuggerUrl':'ws://127.0.0.1/devtools/browser/fixture'}:[]);
        process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: '+Buffer.byteLength(body)+'\\r\\nConnection: close\\r\\n\\r\\n'+body);process.exit(0);
      });return;
    } else process.exit(64);
  } else out = args.includes('base64') || args.some(arg=>arg.includes('base64 <')) ? screenshot()
    : args.includes('--version') ? 'cua-driver ${CUA_DRIVER_VERSION}'
    : args.includes('madani-desktop-probe') || args.includes('health_report') ? {schema_version:'1',overall:'ok',checks:[]} : {};
} else if (args[0] === 'info') out='fixture';
else if (args[0] === 'ps') out='';
else {process.stderr.write('unsupported fixture command');process.exit(64);}
process.stdout.write(typeof out==='string'?out:JSON.stringify(out));
`, { mode: 0o700 });
  writeFileSync(join(binDir, "ssh"), `#!${process.execPath}
const net=require('node:net');
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(sshCalls)},JSON.stringify({pid:process.pid,args})+'\\n');
const forward=args[args.indexOf('-L')+1];
if(!args.includes('-N') || !/^127\\.0\\.0\\.1:[0-9]+:172\\.17\\.0\\.5:690[1-5]$/.test(forward))process.exit(64);
const sockets=new Set();
const server=net.createServer(client=>{
  const peer=net.connect(${desktop.port},'127.0.0.1');
  for(const socket of [client,peer]){sockets.add(socket);socket.on('error',()=>socket.destroy());socket.on('close',()=>{sockets.delete(socket);client.destroy();peer.destroy()});}
  client.pipe(peer).pipe(client);
});
server.listen(Number(forward.split(':')[1]),'127.0.0.1');
process.on('SIGTERM',()=>{server.close();for(const socket of sockets)socket.destroy()});
`, { mode: 0o700 });
  return {
    calls,
    sshCalls,
    records,
    screenRecords,
    hold,
    screenshotHold,
    localVm: { binDir, host: "ssh://127.0.0.1:1", sshKey: join(directory, "unused-key"), staticDir: fileURLToPath(new URL("../../dist", import.meta.url)), vpsDesktop: "cua" as const },
    async close() { await desktop.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
