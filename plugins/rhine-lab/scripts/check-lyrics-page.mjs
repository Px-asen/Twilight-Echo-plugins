import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RHINE_TEST_URL || 'http://127.0.0.1:5321';
const evidence = process.env.RHINE_EVIDENCE_DIR || '.cache/lyrics-evidence';
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [], results = {};
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(45000);
page.on('pageerror', error => { errors.push(String(error.stack)); console.error(error); });
const lrc = '[00:00]声音档案 / SOUND ARCHIVE\n[00:04]在晨雾中寻找方向\n[00:08]让微光穿过无声的海\n[00:12]每一次回声，都有新的坐标\n[00:17]我们仍向未知的远方\n[00:22]那些未被命名的时刻\n[00:27]终将在此留下回响\n[00:32]\n[00:40]继续，直到星河的另一端';
const translation = '[00:00]Sound archive\n[00:04]Finding our way through the mist\n[00:08]Let the light cross a silent sea\n[00:12]Every echo finds a new coordinate\n[00:17]Onward, into the unknown\n[00:22]The moments without names\n[00:27]Will leave their echoes here\n[00:40]Until the other side of the stars';
const harness = `<!doctype html><html><meta charset="utf-8"><body style="margin:0;overflow:hidden"><iframe src="/?lab=0&scene=archive" style="border:0;width:100vw;height:100vh"></iframe><script>
const track = (a,i) => ({id:a+'-'+i,albumId:'album-'+a,title:['未命名的回声','雾中的坐标','向远方'][i],artist:'RHINE SOUND ARCHIVE',album:'回声档案 '+a,duration:240,format:'FLAC',browserPlayable:true,audioUrl:'',relativePath:''});
const albums = Array.from({length:12},(_,a) => ({id:'album-'+a,title:'回声档案 '+String(a+1).padStart(2,'0'),artist:'RHINE SOUND ARCHIVE',genreId:'g'+a%3,rawGenres:[],folder:'synthetic',producers:[],offline:false,coverUrl:'/demo-covers/'+(a%3===0?'square.png':a%3===1?'portrait.png':'landscape.png'),tracks:[0,1,2].map(i=>track(a,i))}));
window.lib={version:1,revision:1,total:albums.length,roots:[],scan:{running:false},onlineEnabled:false,genres:[0,1,2].map(i=>({id:'g'+i,name:'实验声场 '+i})),albums};
window.docs={}; for(const album of albums)for(const t of album.tracks)docs[t.id]={id:t.id,lyrics:${JSON.stringify(lrc)},translatedLyrics:${JSON.stringify(translation)}};
window.state={transport:'paused',currentTrack:albums[0].tracks[0],currentIndex:0,currentTime:13,duration:240,playing:false,loading:false,playbackRate:1,volume:.6,songTransitionMode:'gapless'};
window.delays={};window.fail=false;window.calls=[];let peer;
window.emit=(event,value)=>peer.postMessage({event,value});
window.publish=(patch)=>{window.state={...state,...patch};emit('player',state)};
window.choose=(id)=>{const t=lib.albums.flatMap(a=>a.tracks).find(t=>t.id===id)||{id,albumId:'',title:'远方的信号',artist:'EXTERNAL SIGNAL',duration:240,format:'FLAC',album:'外部播放档案'};publish({currentTrack:t,currentTime:13,duration:t.duration,transport:'paused',playing:false,loading:false});emit('lyrics',{id})};
addEventListener('message',e=>{if(e.data.type!=='twilight-experience-ready')return;const channel=new MessageChannel();peer=channel.port1;peer.onmessage=async({data:r})=>{calls.push([r.method,r.args]);let value=null,error;
try {switch(r.method){
case 'preferences.read':value={localPreferences:{'rhine-music-preferences':JSON.stringify({theme:'day',quality:'original',useDefaultCovers:true,bgm:false,sound:false})}};break;
case 'preferences.write':break;
case 'host.capabilities':value={bridgeVersion:2,methods:['music.library','radio.list','podcasts.list','network.profiles','stats.read','player.sleep']};break;
case 'music.library':value=lib;break;
case 'music.metadata.read':value={revision:1,value:{}};break;
case 'music.metadata.operate':value={};break;
case 'player.state':value=state;break;
case 'player.queue':value=lib.albums.flatMap(a=>a.tracks);break;
case 'player.lyrics':{const id=state.currentTrack?.id;value=structuredClone(docs[id]||{id,lyrics:''});if(fail)throw Error('隔离测试：歌词服务不可用');if(delays[id])await new Promise(r=>setTimeout(r,delays[id]));break;}
case 'player.seek':publish({currentTime:r.args.value});value=state;break;
case 'player.toggle':publish({playing:!state.playing,transport:state.playing?'paused':'playing'});value=state;break;
case 'player.next':{const t=state.currentTrack;choose(t?.id==='0-0'?'0-1':t?.id==='0-1'?'1-0':'0-0');value=state;break;}
case 'player.previous':choose('0-0');value=state;break;
case 'audio.read':value={output:'browser',device:'default',devices:[]};break;
case 'queue.read':value=[];break;
}}catch(e){error=String(e.message)}peer.postMessage({id:r.id,value,error})};e.source.postMessage({type:'twilight-experience-connect',bridgeVersion:2},'*',[channel.port2]);});
setInterval(()=>{if(state.playing&&!state.loading)publish({currentTime:Math.min(state.duration,state.currentTime+.25*state.playbackRate)})},250);
</script></body></html>`;
await page.route('**/__lyrics-test', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: harness }));
try {
  await page.goto(base + '/__lyrics-test');
  const frame = page.frames().find(f => f.parentFrame());
  await frame.locator('.rhine-loading').press('Enter');
  await frame.locator('.rhine-loading').waitFor({ state: 'hidden', timeout: 90000 });
  await frame.waitForFunction(() => window.rhineMusic?.stats()?.loaded);
  await frame.waitForFunction(() => window.rhineMusic.presentation.archiveReady);
  const read = () => frame.evaluate(() => ({ presentation: window.rhineMusic.presentation, lyrics: window.rhineMusic.lyrics(), selected: window.rhineMusic.selectedAlbum?.id }));
  const open = async () => { await frame.locator('#open-lyrics').click(); await frame.locator('#music-lyrics[data-transition="open"]').waitFor(); await frame.waitForFunction(() => window.rhineMusic.lyrics().rendered > 0); };
  const close = async () => { await frame.locator('[data-action="close-lyrics"]').click(); await frame.locator('#music-lyrics').waitFor({ state:'hidden' }); await frame.waitForFunction(() => window.rhineMusic.presentation.phase==='archive' || window.rhineMusic.presentation.phase==='detail' && window.rhineMusic.presentation.content==='album' && document.querySelector('#music-detail').dataset.transition==='open'); };
  // Capture the live scene without adding a production debug mutator.
  await frame.evaluate(async () => {
    const src=await (await fetch('/src/music-app.ts')).text();
    const url=src.match(/from "([^"\n]*\/scene\.ts[^"\n]*)"/)[1];
    const {ArchiveScene}=await import(url); const original=ArchiveScene.prototype.setMusicReading;
    const readerUrl=src.match(/from "([^"\n]*\/lyrics\/reader\.ts[^"\n]*)"/)[1];
    const {LyricsReader}=await import(readerUrl); const update=LyricsReader.prototype.update;
    window.lyricCpu=[];
    LyricsReader.prototype.update=function(now){const t=performance.now();update.call(this,now);if(this.isActive){window.lyricCpu.push(performance.now()-t);if(window.lyricCpu.length>600)window.lyricCpu.shift()}};
    ArchiveScene.prototype.setMusicReading=function(value){window.lyricTestScene=this;return original.call(this,value)};
  });
  const origin = (await read()).selected;
  await open(); await page.waitForTimeout(800);
  assert.equal((await read()).selected, 'album-0');
  assert.equal(await frame.locator('.lyric-row.current').count(),1);
  await page.screenshot({path:evidence+'/day-landscape.png'});
  results.initial=await read();
  const anchored=await frame.locator('.lyric-row.current').evaluate(el=>{const v=el.closest('.lyrics-viewport').getBoundingClientRect(),r=el.getBoundingClientRect();return (r.top-v.top)/v.height});
  assert.ok(Math.abs(anchored-.38)<.03, 'current line anchors at 38%');
  await frame.locator('.lyrics-translation').click();
  assert.equal(await frame.locator('.lyric-translation:visible').count(),0);
  await frame.locator('.lyrics-translation').click(); await page.waitForTimeout(550);
  const selected=(await read()).selected;
  await frame.locator('.lyrics-viewport').hover(); await page.mouse.wheel(0,270);
  await frame.locator('.lyrics-follow').waitFor(); await page.waitForTimeout(300);
  assert.equal((await read()).selected,selected,'lyric wheel does not navigate shelf');
  await page.waitForTimeout(5300); assert.equal(await frame.locator('.lyrics-follow').isVisible(),false);
  await close(); assert.equal((await read()).selected,origin,'archive origin restored');
  // Detail tab and scroll restoration, from a different playing album.
  await frame.locator('[data-action="open"]').click(); await frame.locator('#music-detail[data-transition="open"]').waitFor();
  await frame.locator('[data-tab="about"]').click();
  await frame.locator('#album-detail-content').evaluate(el=>el.scrollTop=120);
  const beforeDetail=await frame.locator('#album-detail-content').evaluate(el=>el.scrollTop);
  await open();
  assert.equal(await frame.evaluate(()=>window.lyricTestScene.musicPresentation.phase),'presented','lyric entry waits for the reframed camera');
  await close();
  assert.equal(await frame.locator('[data-tab="about"]').getAttribute('aria-selected'),'true');
  assert.ok(Math.abs(await frame.locator('#album-detail-content').evaluate(el=>el.scrollTop)-beforeDetail)<2);
  await page.waitForTimeout(3500);
  results.detailPerformance = await frame.evaluate(()=>({quality:JSON.parse(document.querySelector('#three-scene').dataset.renderQuality),timing:JSON.parse(document.querySelector('#three-scene').dataset.frameTiming)}));
  // Same-album change keeps CD lift; cross album changes selection.
  await open();
  const sameBefore=await frame.evaluate(()=>window.lyricTestScene.outgoing.length);
  await frame.locator('.lyrics-next').click(); await page.waitForTimeout(650);
  assert.equal((await read()).lyrics.trackId,'0-1');
  assert.equal(await frame.evaluate(()=>window.lyricTestScene.outgoing.length),sameBefore);
  await frame.locator('.lyrics-next').click();
  await frame.waitForFunction(()=>window.rhineMusic.selectedAlbum.id==='album-1'&&window.rhineMusic.presentation.phase==='detail');
  // Late requests are intentionally delivered after a newer song.
  await page.evaluate(()=>{delays['0-0']=1100;choose('0-0');setTimeout(()=>choose('0-1'),50)});
  await frame.waitForFunction(()=>window.rhineMusic.lyrics().trackId==='0-1'); await page.waitForTimeout(1500);
  assert.equal((await read()).lyrics.trackId,'0-1');
  assert.ok(!(await frame.locator('.lyrics-window').innerText()).includes('wrong'));
  // Word timing, interlude, seek, pause and rate use the host clock.
  await frame.locator('.lyrics-content[data-transition="open"]').waitFor();
  const retiringText=await frame.locator('.lyrics-window').innerText();
  await page.evaluate(()=>{docs['0-1']={id:'0-1',lyrics:'[00:00]<00:00.000>莱<00:02.000>茵<00:04.000>生命<00:06.000>\n[00:10]下一段\n[00:20]\n[00:30]终点',translatedLyrics:'[00:00]Rhine Lab'};publish({currentTime:2.5});emit('lyrics',{})});
  await frame.locator('.lyrics-content[data-transition="closing"]').waitFor();
  assert.equal(await frame.locator('.lyrics-window').innerText(),retiringText,'content is replaced only after its exit finishes');
  await frame.waitForFunction(()=>document.querySelectorAll('.lyric-word').length>0); await page.waitForTimeout(400);
  results.wordFill=await frame.locator('.lyric-word').evaluateAll(nodes=>nodes.map(n=>n.style.getPropertyValue('--word-fill')));
  assert.ok(results.wordFill.includes('25%'));
  await frame.evaluate(async()=>{const src=await(await fetch('/src/music-app.ts')).text();const url=src.match(/from "([^"\n]*\/music-motion-settings\.ts[^"\n]*)"/)[1];window.lyricMotionSettings=await import(url);window.lyricMotionSettings.setMusicMotionSpeed(3)});
  await page.waitForTimeout(250);
  assert.ok((await frame.locator('.lyric-word').evaluateAll(nodes=>nodes.map(n=>n.style.getPropertyValue('--word-fill')))).includes('25%'),'UI speed does not alter lyric time');
  await frame.evaluate(()=>window.lyricMotionSettings.setMusicMotionSpeed(1));
  await page.evaluate(()=>publish({currentTime:2.5,playing:true,transport:'loading',loading:true}));await page.waitForTimeout(600);
  assert.ok((await frame.locator('.lyric-word').evaluateAll(nodes=>nodes.map(n=>n.style.getPropertyValue('--word-fill')))).includes('25%'),'buffering freezes word time');
  await page.evaluate(()=>publish({playing:false,transport:'paused',loading:false}));
  await frame.locator('.lyric-row[data-lyric-index="1"]').click();
  await page.waitForFunction(()=>state.currentTime===10);
  assert.equal(await page.evaluate(()=>state.currentTime),10);
  await frame.locator('.lyrics-seek input').evaluate(el=>{el.value='35';el.dispatchEvent(new Event('input',{bubbles:true}))}); await frame.locator('.lyrics-seek input').dispatchEvent('change');
  await page.waitForFunction(()=>state.currentTime===35);
  assert.equal(await page.evaluate(()=>state.currentTime),35);
  await page.evaluate(()=>publish({currentTime:2,playing:true,transport:'playing',playbackRate:2})); await page.waitForTimeout(1000);
  assert.ok(await page.evaluate(()=>state.currentTime)>=3.5);
  await page.evaluate(()=>publish({playing:false,transport:'paused'}));
  const frozen=await frame.locator('.lyrics-time').innerText(); await page.waitForTimeout(1100); assert.equal(await frame.locator('.lyrics-time').innerText(),frozen);
  await page.evaluate(()=>publish({currentTime:22,playing:false,transport:'paused'})); await page.waitForTimeout(200);
  assert.match(await frame.locator('.lyrics-sync-status').innerText(),/间奏/);
  await page.evaluate(()=>{docs['0-1']={id:'0-1',lyrics:'<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><p begin="00:01.00" end="00:05.00"><span begin="00:01.00" end="00:03.00">Rhine </span><span begin="00:03.00" end="00:05.00">Lab</span><span ttm:role="x-translation">莱茵生命</span></p></body></tt>'};publish({currentTime:2});emit('lyrics',{})});
  await frame.waitForFunction(()=>document.querySelector('.lyric-translation')?.textContent==='莱茵生命');
  await page.screenshot({path:evidence+'/ttml-word-sync.png'});
  await page.evaluate(()=>{docs['0-1']={id:'0-1',lyrics:'[1000,3000](1000,1000,0)莱(2000,1000,0)茵(3000,1000,0)生命'};publish({currentTime:2.5});emit('lyrics',{})});
  await frame.waitForFunction(()=>document.querySelectorAll('.lyric-word').length===3); await page.waitForTimeout(200);
  assert.ok((await frame.locator('.lyric-word').evaluateAll(nodes=>nodes.map(n=>n.style.getPropertyValue('--word-fill')))).includes('50%'));
  // Plain / missing / failure / retry are distinct states.
  await page.evaluate(()=>{docs['0-1']={id:'0-1',lyrics:'没有时间轴的文字\n仍然可以自由阅读\nPlain text archive'};emit('lyrics',{})});
  await frame.locator('#music-lyrics[data-timed="false"]').waitFor();
  assert.equal(await frame.locator('.lyric-row[aria-current]').count(),0);
  await page.evaluate(()=>{docs['0-1']={id:'0-1',lyrics:''};emit('lyrics',{})}); await frame.locator('#music-lyrics[data-lyric-state="empty"]').waitFor();
  await page.evaluate(()=>{fail=true;emit('lyrics',{})}); await frame.locator('#music-lyrics[data-lyric-state="error"]').waitFor();
  await page.evaluate(({lrc,translation})=>{fail=false;docs['0-1']={id:'0-1',lyrics:lrc,translatedLyrics:translation}}, {lrc,translation});
  await frame.locator('.lyrics-retry').click(); await frame.locator('#music-lyrics[data-lyric-state="ready"]').waitFor();
  // A transient failure must not discard an unchanged successful parse.
  const parsesBeforeRetry=(await read()).lyrics.parses;
  await page.evaluate(()=>{fail=true;emit('lyrics',{})});await frame.locator('#music-lyrics[data-lyric-state="error"]').waitFor();
  await page.evaluate(()=>{fail=false});await frame.locator('.lyrics-retry').click();await frame.locator('#music-lyrics[data-lyric-state="ready"]').waitFor();
  await frame.waitForFunction(()=>window.rhineMusic.lyrics().rendered===9);
  assert.equal((await read()).lyrics.parses,parsesBeforeRetry,'retry reuses the unchanged parsed document');
  // Both palettes and portrait framing, at unchanged original quality.
  await frame.locator('.theme-switch [data-theme="night"]').click(); await page.waitForTimeout(1500);
  await page.screenshot({path:evidence+'/night-landscape.png'});
  await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(1800);
  await page.screenshot({path:evidence+'/night-portrait.png'});
  results.portrait=await frame.evaluate(()=>({center:window.rhineMusic.stats().projectedCenter,reader:document.querySelector('.lyrics-reader').getBoundingClientRect().toJSON(),width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
  assert.equal(results.portrait.width,results.portrait.scrollWidth);
  await frame.locator('.theme-switch [data-theme="day"]').click(); await page.waitForTimeout(1200);
  await page.screenshot({path:evidence+'/day-portrait.png'});
  await page.setViewportSize({width:1440,height:960});
  // Thousand lines, multiline height, bounded DOM and stable textures.
  await page.evaluate(()=>{docs['0-1']={id:'0-1',lyrics:Array.from({length:1000},(_,i)=>'['+String(Math.floor(i*3/60)).padStart(2,'0')+':'+String(i*3%60).padStart(2,'0')+']'+(i%10===0?'长行用于验证自动换行和高度缓存。'.repeat(8):'回声档案，第 '+i+' 行')).join('\n')};publish({duration:3000,currentTime:1501});emit('lyrics',{})});
  await frame.waitForFunction(()=>window.rhineMusic.lyrics().lines===1000); await page.waitForTimeout(1800);
  assert.ok((await read()).lyrics.rendered<=48);
  const steadyBefore=await frame.evaluate(()=>({s:window.lyricTestScene.getStats(),version:window.lyricTestScene.covers.selectedTexture.version,measure:window.rhineMusic.lyrics().measuredRows}));
  await page.waitForTimeout(2000);
  const steadyAfter=await frame.evaluate(()=>({s:window.lyricTestScene.getStats(),version:window.lyricTestScene.covers.selectedTexture.version,measure:window.rhineMusic.lyrics().measuredRows}));
  assert.equal(steadyAfter.version,steadyBefore.version,'lyric frames do not upload covers');
  assert.equal(steadyAfter.measure,steadyBefore.measure,'steady frames do not measure layout');
  assert.equal(steadyAfter.s.covers.uploadCalls,steadyBefore.s.covers.uploadCalls,'no atlas uploads caused by lyric frames');
  assert.deepEqual(steadyAfter.s.graphics,steadyBefore.s.graphics,'steady lyric resource inventory');
  results.lyricPerformance=await frame.evaluate(()=>{const values=[...window.lyricCpu].sort((a,b)=>a-b);return {quality:JSON.parse(document.querySelector('#three-scene').dataset.renderQuality),timing:JSON.parse(document.querySelector('#three-scene').dataset.frameTiming),readerCpuP95:values[Math.floor(values.length*.95)]||0}});
  assert.deepEqual(results.lyricPerformance.quality,results.detailPerformance.quality,'exactly unchanged render quality');
  assert.equal(await frame.locator('canvas').count(),1);
  results.thousand={...(await read()),steadyBefore,steadyAfter};
  await page.screenshot({path:evidence+'/thousand-lines.png'});
  // Background suspension stops the single main loop and resumes from host progress.
  const workBefore=(await read()).lyrics.measuredRows;
  await frame.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))});
  await page.waitForTimeout(600);assert.equal((await read()).lyrics.measuredRows,workBefore);
  await frame.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});
  // External playback uses a display record without library insertion.
  await page.evaluate(()=>{docs.external={id:'external',lyrics:'[00:00]来自曲库之外的信号'};choose('external')});
  await frame.waitForFunction(()=>window.rhineMusic.lyrics().trackId==='external'&&window.rhineMusic.presentation.phase==='detail');
  assert.equal(await frame.evaluate(()=>window.rhineMusic.library.albums.length),12);
  assert.equal(await frame.evaluate(()=>window.lyricTestScene.musicDisplayRecord.album.title),'外部播放档案');
  await close();
  // Workspace entry dispatches the same reading surface.
  await frame.locator('.host-workspace-launcher').click(); await frame.locator('#host-tab-lyrics').click();
  await frame.locator('#music-lyrics[data-transition="open"]').waitFor();
  assert.equal(await frame.locator('.host-workspace').evaluate(el=>el.open),false);
  await frame.locator('.lyrics-viewport').press('Escape'); await frame.locator('#music-lyrics').waitFor({state:'hidden'});
  // Escape during entry; reopen during an in-flight exit. No stale surface wins.
  await frame.waitForFunction(()=>window.rhineMusic.presentation.content==='album'&&window.rhineMusic.presentation.phase==='detail');
  await frame.locator('[data-action="back"]').click(); await frame.waitForFunction(()=>window.rhineMusic.presentation.phase==='archive');
  await page.evaluate(()=>choose('0-0'));
  await frame.locator('#open-lyrics').click();
  await frame.locator('#open-lyrics').press('Escape');
  await frame.waitForFunction(()=>window.rhineMusic.presentation.phase==='archive');
  assert.equal(await frame.locator('#music-lyrics').isVisible(),false);
  await open();
  await frame.locator('[data-action="close-lyrics"]').click();
  await frame.locator('#open-lyrics').click();
  await frame.locator('#music-lyrics[data-transition="open"]').waitFor();
  assert.equal((await read()).lyrics.active,true);
  await close();
  await frame.waitForFunction(()=>window.rhineMusic.presentation.phase==='archive');
  // Browse a different album; closing restores that stable ID, not the playback album.
  await frame.locator('[data-action="next"]').first().click();
  await frame.waitForFunction(()=>window.rhineMusic.presentation.archiveReady);
  const browsed=(await read()).selected; assert.notEqual(browsed,'album-0');
  await open(); assert.equal((await read()).selected,'album-0');
  await page.evaluate(()=>publish({playing:true,transport:'playing'}));
  await close(); assert.equal((await read()).selected,browsed);
  assert.equal(await page.evaluate(()=>state.playing),true,'closing never pauses playback');
  await page.evaluate(()=>publish({playing:false,transport:'paused'}));
  // Overview entry/return retains both the selection and overview state.
  await frame.locator('[data-action="overview"]').click();
  await frame.waitForFunction(()=>document.querySelector('#stage').dataset.overview==='true');
  await open(); await close();
  assert.equal(await frame.locator('#stage').getAttribute('data-overview'),'true');
  await frame.locator('.overview-return').click(); await frame.waitForFunction(()=>window.rhineMusic.presentation.archiveReady);
  // A library refresh cannot replace the current lyric document or lose its return origin.
  await open();
  await page.evaluate(()=>{lib={...lib,revision:lib.revision+1,albums:lib.albums.map(a=>({...a,title:a.title+' / 更新'}))};emit('library',{})});
  // Poll through the same existing host read path. No private app write hooks.
  await frame.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await frame.waitForFunction(()=>window.rhineMusic.selectedAlbum.title.includes('更新')&&window.rhineMusic.presentation.content==='lyrics'&&window.rhineMusic.presentation.phase==='detail');
  await close(); assert.equal((await read()).selected,browsed);
  // Remove the saved origin while reading: return to the existing rack.
  await open();
  await page.evaluate(id=>{lib={...lib,revision:lib.revision+1,albums:lib.albums.filter(a=>a.id!==id)};lib.total=lib.albums.length},browsed);
  await frame.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await frame.waitForFunction(()=>window.rhineMusic.library.albums.length===11&&window.rhineMusic.presentation.phase==='detail');
  await close(); assert.equal((await read()).presentation.phase,'archive');
  // Empty libraries still display external audio without appending a fake album.
  await page.evaluate(()=>{lib={...lib,revision:lib.revision+1,total:0,albums:[]};choose('external')});
  await frame.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await frame.waitForFunction(()=>window.rhineMusic.library.albums.length===0);
  await open();
  assert.equal(await frame.evaluate(()=>window.lyricTestScene.model.visible),true);
  assert.equal(await frame.evaluate(()=>window.rhineMusic.library.albums.length),0);
  await page.screenshot({path:evidence+'/external-empty-library.png'});
  await close();
  const stopped=(await read()).lyrics;
  await page.waitForTimeout(650); assert.equal((await read()).lyrics.measuredRows,stopped.measuredRows);
  results.closed=await read();
  await page.evaluate(()=>emit('lyrics',{}));await page.waitForTimeout(250);
  assert.equal((await read()).lyrics.parses,results.closed.lyrics.parses,'closed pages do not parse lyrics');
  await frame.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await frame.locator('canvas').count(),0,'page disposal releases its only renderer');
  assert.equal(await frame.evaluate(()=>window.rhineMusic.lyrics().rendered),0);
  results.disposal={canvases:0,rendered:0};
  assert.equal(errors.length,0,errors.join('\n'));
  results.errors=errors;results.status='passed';
  await writeFile(evidence+'/results.json',JSON.stringify(results,null,2));
  console.log('Lyrics integration passed:',JSON.stringify({initial:results.initial,thousand:results.thousand.lyrics,portrait:results.portrait}));
} catch(error) {
  await page.screenshot({path:evidence+'/failure.png'}).catch(()=>{});
  await writeFile(evidence+'/failure.txt',String(error.stack)+'\n'+errors.join('\n'));
  throw error;
} finally {await browser.close()}
