import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fitFrozenLines} from "../scripts/lib/dub-timing.mjs";
import {replaceDubAudio} from "../scripts/dub.mjs";
import {ffmpeg,probeDuration} from "../scripts/lib/ffmpeg.mjs";

const frozen={duration:2,lines:[{id:"a",text:"Hello",start:0.2,end:1.2}]};
const voice=[{id:"a",text:"Hello",start:0,end:0.5,words:[{w:"Hello",start:0.1,end:0.4}]}];
test("frozen fit keeps starts and text, scales words, rejects overflow and caption changes",()=>{
 const fit=fitFrozenLines(frozen,voice,new Map([["a",1.1]]))[0];
 assert.equal(fit.start,0.2);assert.equal(fit.atempoFactor,1.1);
 assert.ok(Math.abs(fit.words[0].start-(0.2+0.1/1.1))<1e-9);
 assert.throws(()=>fitFrozenLines(frozen,voice,new Map([["a",1.3]])),/edit pauses/);
 assert.throws(()=>fitFrozenLines(frozen,[{...voice[0],text:"Changed"}],new Map([["a",0.5]])),/caption/);
 assert.throws(()=>fitFrozenLines({...frozen,lines:[{...frozen.lines[0],id:"../a"}]},voice,new Map()),/invalid/);
 assert.throws(()=>fitFrozenLines({...frozen,duration:NaN},voice,new Map()),/duration/);
 assert.throws(()=>fitFrozenLines(frozen,voice,new Map([["a",NaN]])),/duration/);
 const boundary=fitFrozenLines({duration:1,lines:[{id:"a",text:"Hello",start:0.2,end:0.3}]},voice,new Map([["a",0.12]]));
 assert.equal(boundary[0].atempoFactor,1.2);
});

test("revoice copies final video bytes, preserves source/timings, and needs no reel.html",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"sva-revoice-"));
 const vd=path.join(dir,"dub/en/voice");fs.mkdirSync(vd,{recursive:true});
 const video=path.join(dir,"final.mp4"),bed=path.join(dir,"bed.wav"),timings=path.join(dir,"frozen.json");
 try {
  fs.writeFileSync(timings,JSON.stringify(frozen));
  fs.writeFileSync(path.join(dir,"dub/en/plan.json"),JSON.stringify({meta:{lang:"en"},lines:[{id:"a",text:"Hello"}]}));
  fs.writeFileSync(path.join(vd,"timings.json"),JSON.stringify({duration:0.5,lines:voice}));
  await ffmpeg(["-y","-f","lavfi","-i","testsrc2=size=64x64:rate=10:duration=2","-c:v","libx264","-pix_fmt","yuv420p",video]);
  await ffmpeg(["-y","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-t","2",bed]);
  await ffmpeg(["-y","-f","lavfi","-i","sine=frequency=500:sample_rate=48000:duration=0.5",path.join(vd,"line-a.wav")]);
  const original=fs.readFileSync(video),clock=fs.readFileSync(timings);
  const result=await replaceDubAudio({dir,lang:"en",videoPath:video,timingsPath:timings,bedPath:bed});
  const hash=async p=>(await ffmpeg(["-i",p,"-map","0:v:0","-c","copy","-f","hash","-hash","sha256","-"])).stdout.toString();
  assert.equal(await hash(result.outPath),await hash(video));
  assert.deepEqual(fs.readFileSync(video),original);assert.deepEqual(fs.readFileSync(timings),clock);
  assert.ok(Math.abs(await probeDuration(result.outPath)-2)<0.03);
  assert.equal(JSON.parse(fs.readFileSync(result.outPath+".json")).videoMode,"stream-copy");
  const outputCount=fs.readdirSync(path.join(dir,"out")).length;
  fs.writeFileSync(timings,JSON.stringify({duration:2,lines:[{id:"a",text:"Hello",start:1,end:2}]}));
  await ffmpeg(["-y","-f","lavfi","-i","sine=frequency=500:sample_rate=48000:duration=1.1",path.join(vd,"line-a.wav")]);
  await assert.rejects(replaceDubAudio({dir,lang:"en",videoPath:video,timingsPath:timings,bedPath:bed}),/measured fitted audio exceeds/);
  assert.equal(fs.readdirSync(path.join(dir,"out")).length,outputCount,"overflow must not publish a truncated final clip");
  fs.writeFileSync(timings,JSON.stringify({...frozen,duration:4}));
  await assert.rejects(replaceDubAudio({dir,lang:"en",videoPath:video,timingsPath:timings,bedPath:bed}),/same clock/);
  assert.equal(fs.readdirSync(path.join(dir,"out")).length,outputCount);
  await assert.rejects(replaceDubAudio({dir,lang:"en",videoPath:video,timingsPath:timings,bedPath:path.join(dir,"missing.wav")}),/clean bed/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
