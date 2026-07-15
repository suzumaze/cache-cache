import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness } from '../lib/freshness.js';
import { toHeaderMap } from '../lib/headers.js';
import { h, NOW } from './fixtures.js';

const fr = (obj, extra = {}) => freshness(toHeaderMap(h(obj)), { now: NOW, receiveTime: NOW, ...extra });

test('max-age=600・age=0 → カウントダウン', () => {
  const f = fr({ 'cache-control': 'public, max-age=600', age: '0' });
  assert.equal(f.mode, 'countdown');
  assert.ok(Math.abs(f.remainingSec - 600) < 2);
});

test('max-age が24時間超 → 作成日', () => {
  const f = fr({ 'cache-control': 'public, max-age=100000', date: 'Fri, 19 Jun 2026 12:00:00 GMT' });
  assert.equal(f.mode, 'created');
  assert.ok(f.createdAt instanceof Date);
});

test('immutable → 作成日', () => {
  const f = fr({ 'cache-control': 'public, max-age=31536000, immutable', date: 'Fri, 19 Jun 2026 12:00:00 GMT' });
  assert.equal(f.mode, 'created');
});

test('作成日は Age を引いた投入時刻（Date=配信時刻に引きずられない）', () => {
  // max-age=1年・age=7200(2時間)。Fastly は Date を配信時刻へ書き換えるが、作成時刻は受信の2時間前。
  const f = fr({ 'cache-control': 'public, max-age=31536000', date: 'Fri, 19 Jun 2026 12:00:00 GMT', age: '7200' });
  assert.equal(f.mode, 'created');
  assert.equal(f.createdAt.getTime(), NOW - 7200 * 1000);
});

test('Cache-Control 不在・Age あり → 不明（非公開）', () => {
  const f = fr({ age: '7' });
  assert.equal(f.mode, 'unknown');
  assert.equal(f.ageKnown, true);
  assert.ok(Math.abs(f.ageSec - 7) < 1);
});

test('no-store → 毎回更新', () => {
  const f = fr({ 'cache-control': 'no-store' });
  assert.equal(f.mode, 'no-store');
});

test('Expires - Date でカウントダウン', () => {
  const f = fr({ date: 'Fri, 19 Jun 2026 12:00:00 GMT', expires: 'Fri, 19 Jun 2026 12:30:00 GMT' });
  assert.equal(f.mode, 'countdown');
  assert.ok(Math.abs(f.remainingSec - 1800) < 2);
});

test('s-maxage が max-age より優先', () => {
  const f = fr({ 'cache-control': 'max-age=60, s-maxage=600', age: '0' });
  assert.ok(Math.abs(f.remainingSec - 600) < 2);
});

test('Surrogate-Control max-age が最優先', () => {
  const f = fr({ 'cache-control': 'max-age=60', 'surrogate-control': 'max-age=600', age: '0' });
  assert.ok(Math.abs(f.remainingSec - 600) < 2);
});

test('受信後の経過が current_age に加算される', () => {
  const f = fr({ 'cache-control': 'max-age=600', age: '10' }, { now: NOW + 5000, receiveTime: NOW });
  assert.ok(Math.abs(f.ageSec - 15) < 1); // 10 + 5秒
});
