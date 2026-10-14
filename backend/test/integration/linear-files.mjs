// Linear files integration test: scan → download (Linear simulated) → upload → rewrite
// against the real local backend, then everything a second time. Expected: images served
// via /img/<token>, references rewritten, the second pass changes nothing.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';
import { runDownload, runRewrite, runScan, runUpload } from '../../../tooling/linear-import/files.ts';

const ORG = 'https://uploads.linear.app/0a1b2c3d-0000-4000-8000-000000000000';
const A = `${ORG}/aaaa1111-0000-4000-8000-000000000000/bbbb2222-0000-4000-8000-000000000000`;
const B = `${ORG}/cccc3333-0000-4000-8000-000000000000/dddd4444-0000-4000-8000-000000000000`;
const VIDEO = `${ORG}/eeee5555-0000-4000-8000-000000000000/ffff6666-0000-4000-8000-000000000000`;
const DRIVE = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

const urls0 = (markdown) => /\]\(([^)]+)\)/.exec(markdown)[1];

export async function linearFilesSuite(backend, log) {
  const work = mkdtempSync(join(tmpdir(), 'selfbound-linear-files-test-'));
  try {
    const admin = new ConvexHttpClient(backend.url);
    admin.setAuth(backend.token);
    const { teamId } = await admin.mutation(api.teams.create, { key: 'LFI', name: 'Linear files' });
    const created = await admin.mutation(api.issues.create, {
      issues: [{ teamId, title: 'With images', description: `![a](${A}?signature=abc.def.ghi)\n\n![b](${B})\n\n[Video](${VIDEO})` }],
    });
    const issue = created.issues[0];
    await admin.mutation(api.comments.add, { issueId: issue.id, body: `- [Attachment](${A})` });

    const quiet = () => {};
    const o = { backendDir: backend.dir, dir: work, print: quiet, yes: true };
    const keyFile = join(work, 'linear-api-key');
    writeFileSync(keyFile, 'lin_api_test', { mode: 0o600 });
    const asked = [];
    const CDN = 'https://storage.example/b?sig=1';
    const linear = async (url, init) => {
      asked.push({ url, method: init.method, auth: init.headers?.Authorization, redirect: init.redirect });
      // B redirects (like to a storage bucket with a signed URL); no key is sent there.
      if (url === B) return new Response(null, { status: 302, headers: { location: CDN } });
      const body = url === VIDEO ? MP4 : PNG; // A and B have the same content
      return new Response(body, { status: 200, headers: { 'content-type': url === VIDEO ? 'video/mp4' : 'image/png' } });
    };

    const scan = await runScan(o);
    assert.equal(scan.files, 3);
    assert.deepEqual(scan.perTable, { issueBodies: { texts: 1, refs: 3 }, comments: { texts: 1, refs: 1 } });

    const dl = await runDownload({ ...o, keyFile, fetch: linear });
    assert.equal(dl.downloaded, 3);
    const toLinear = asked.filter((a) => a.url !== CDN);
    assert.ok(toLinear.every((a) => a.method === 'GET' && a.auth === 'lin_api_test' && !a.url.includes('?')), 'GET only, without signature, with key');
    assert.deepEqual(
      asked.filter((a) => a.url === CDN).map((a) => [a.auth, a.redirect]),
      [[undefined, 'manual']],
      'redirect followed once, without key',
    );
    assert.ok(asked.every((a) => a.redirect === 'manual'));
    const videoSha = dl.manifest[VIDEO].sha256;

    const up = await runUpload(o);
    assert.deepEqual(up, { uploaded: 1, linked: 0, already: 0, skipped: 1, rejected: 0 }, 'one image (A and B identical), the video stays');

    const rw = await runRewrite({ ...o, links: { [videoSha]: DRIVE } });
    assert.deepEqual(rw, { written: 2, remaining: 0 });

    const detail = await admin.query(api.issues.detail, { id: issue.id });
    const markdown = detail.body.markdown;
    assert.equal(detail.comments[0].body, `- [Attachment](${urls0(markdown)})`);
    const urls = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    assert.equal(urls.length, 3);
    assert.ok(urls[0].startsWith(`${backend.siteUrl}/img/`) && urls[0] === urls[1], 'A and B point to the same image');
    assert.equal(urls[2], DRIVE);
    const image = await fetch(urls[0]);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PNG);

    // Second pass: nothing left to do.
    asked.length = 0;
    assert.equal((await runScan(o)).files, 0);
    assert.equal((await runDownload({ ...o, keyFile, fetch: linear })).downloaded, 0);
    assert.equal(asked.length, 0, 'second download does not contact Linear');
    assert.deepEqual(await runUpload(o), { uploaded: 0, linked: 0, already: 1, skipped: 1, rejected: 0 });
    assert.deepEqual(await runRewrite({ ...o, links: { [videoSha]: DRIVE } }), { written: 0, remaining: 0 });
    log('Linear files: 3 files, 1 image uploaded, 1 video as Drive link, 2 texts rewritten; second pass without changes');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
