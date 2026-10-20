import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLyricLines, getLyricWordProgress } from '../src/lyrics/vendor/lyrics.ts';
import { LyricClock, LyricHeights, LyricRequests } from '../src/lyrics/runtime.ts';

test('host parsers preserve LRC repeats, enhanced LRC, YRC, translation, plain text and TTML layers', () => {
  const repeated = buildLyricLines('[00:01][00:03]回声\n[00:05]远方', '[00:01]Echo\n[00:03]Echo again');
  assert.deepEqual(repeated.map(l => l.time), [1, 3, 5]);
  assert.equal(repeated[1].translation, 'Echo again');
  const enhanced = buildLyricLines('[00:01]<00:01.000>Rhine <00:02.000>Lab<00:03.000>', undefined);
  assert.equal(enhanced[0].words[0].time, 1);
  assert.equal(getLyricWordProgress(enhanced[0].words[0], 2, 1.5), .5);
  const yrc = buildLyricLines('[1000,3000](1000,800,0)莱(1800,800,0)茵(2600,1400,0)生命', '[00:01.2]Rhine Lab');
  assert.equal(yrc[0].words.length, 3); assert.equal(yrc[0].words[2].endTime, 4);
  assert.equal(yrc[0].translation, 'Rhine Lab');
  const plain = buildLyricLines('第一行\n第二行', 'First\nSecond');
  assert.ok(plain.every(l => !l.timed && l.time === null));
  assert.equal(plain[1].translation, 'Second');
  const ttml = buildLyricLines(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="00:01.000" end="00:04.000"><span begin="00:01.000" end="00:02.000">Rhine </span><span begin="00:02.000" end="00:04.000">Lab</span><span ttm:role="x-translation" xml:lang="zh-CN">莱茵生命</span></p></div></body></tt>`, undefined);
  assert.equal(ttml[0].time, 1); assert.equal(ttml[0].words.length, 2);
  assert.equal(ttml[0].voices[0].translation.text, '莱茵生命');
  assert.equal(buildLyricLines('', undefined).length, 0);
});

test('TTML offsets share the parent start and do not retime resolved background/translation roots', () => {
  const [line] = buildLyricLines(`<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><p begin="1s" end="7s"><span begin="1s" end="3s">Rhine </span><span begin="3s" end="5s">Lab</span><span ttm:role="x-translation" begin="0s" end="6s"><span begin="1s" end="2s">莱茵生命</span></span><span ttm:role="x-bg" begin="2s" end="6s"><span begin="0.5s" end="1.5s">Echo</span></span></p></body></tt>`);
  const lead = line.voices.find(v => v.role === 'lead');
  const background = line.voices.find(v => v.role === 'background');
  assert.equal(lead.time, 1); assert.equal(lead.endTime, 7);
  assert.deepEqual(lead.words.map(w => [w.time, w.endTime]), [[2,4],[4,6]]);
  assert.equal(getLyricWordProgress(lead.words[0], null, 3), .5);
  assert.deepEqual(lead.translation.words.map(w => [w.time, w.endTime]), [[2,3]]);
  assert.equal(background.time, 3); assert.equal(background.endTime, 7);
  assert.deepEqual(background.words.map(w => [w.time, w.endTime]), [[3.5,4.5]]);
  const [direct] = buildLyricLines('<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><p begin="1s" end="7s">Lead<span ttm:role="x-bg" begin="5s" end="6s">Echo</span></p></body></tt>');
  assert.deepEqual(direct.voices.find(v => v.role === 'background').words.map(w => [w.time, w.endTime]), [[6,7]]);
});
test('playback clock interpolates true rate, freezes buffering/paused, calibrates seek and track changes', () => {
  const clock = new LyricClock();
  let state = { currentTrack: { id: 'a' }, currentTime: 10, duration: 200, playing: true, loading: false, playbackRate: 2 };
  clock.sample(state, 1000); assert.equal(clock.at(1250), 10.5);
  clock.sample(state, 1100); assert.equal(clock.at(1250), 10.5, 'non-progress notifications do not restart interpolation');
  state = { ...state, currentTime: 10.6, playing: false }; clock.sample(state, 1300); assert.equal(clock.at(5000), 10.6);
  state = { ...state, playing: true, loading: true }; clock.sample(state, 5100); assert.equal(clock.at(5500), 10.6);
  state = { ...state, loading: false }; clock.sample(state, 5600); assert.equal(clock.at(5850), 11.1);
  clock.seek(90, 6000); clock.sample({ ...state, currentTime: 11 }, 6100); assert.equal(clock.at(6250), 90.5);
  clock.sample({ ...state, currentTrack: { id: 'b' }, currentTime: 0 }, 6300); assert.equal(clock.at(6550), .5);
});
test('requests isolate song IDs, revisions, cancellation, empty and failures', async () => {
  const pending = []; const source = new LyricRequests(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const a = source.load('a'), b = source.load('b');
  pending[0].resolve({ id: 'a', lyrics: 'old' }); assert.equal(await a, undefined);
  pending[1].resolve({ id: 'b', lyrics: '[00:01]new' }); assert.equal((await b).status, 'ready');
  const c = source.load('b'); pending[2].resolve({ id: 'a', lyrics: 'wrong' }); assert.equal((await c).status, 'error');
  const d = source.load('b'); pending[3].resolve({ id: 'b', lyrics: '' }); assert.equal((await d).status, 'empty');
  const e = source.load('b'); pending[4].reject(new Error('offline')); assert.equal((await e).message, 'offline');
  const f = source.load('b'); source.cancel(); pending[5].resolve({ id: 'b', lyrics: 'late' }); assert.equal(await f, undefined);
});
test('thousand-line variable heights keep bounded windows, including jumps and tall wrapped lines', () => {
  const heights = new LyricHeights(); heights.reset(1000, 100); heights.heights[500] = 1200; heights.rebuild();
  assert.equal(heights.indexAt(50000 + 1100), 500);
  for (let scroll = 0; scroll < heights.offsets.at(-1); scroll += 437) {
    const { first, last } = heights.window(scroll, 800, 304);
    assert.ok(last - first <= 48); assert.ok(first >= 0 && last <= 1000);
  }
});
