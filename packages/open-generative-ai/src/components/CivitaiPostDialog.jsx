// "Post to Civitai" — the one place a creation leaves this machine unencrypted.
//
// Everything else the studio holds is sealed, and this deliberately is not:
// publishing sealed bytes is a contradiction. So the consequence is stated
// before the button, not after it, in the same shape the cloud-reference upload
// already asks (lib/cloudReferenceUpload.js): what leaves, where it goes, and
// that it cannot be taken back.
//
// The file is read and measured on open, so the limits Civitai enforces are
// answered here — with the number that fails — instead of inside somebody
// else's uploader after a 700 MB round trip.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { zh } from '../lib/i18n.js';
import {
  CIVITAI_LIMITS, CIVITAI_UPLOAD_URL, canHandOffDirectly, dropCivitaiPost, formatBytes,
  normalizeTags, postMetaFromEntry, prepareCivitaiPost, stageCivitaiPost,
} from '../lib/civitaiPost.js';
import { Icon } from '../ui/icons.jsx';
import { Modal } from '../ui/Modal.jsx';
import { Button, Field, Spinner, TextArea, TextInput, cx } from '../ui/kit.jsx';

export function CivitaiPostDialog({ url, entry, filename, onClose }) {
  const [prepared, setPrepared] = useState(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(null);
  const stagedToken = useRef('');

  // Decrypt and measure once, on open.
  useEffect(() => {
    let alive = true;
    setError('');
    prepareCivitaiPost(url).then(
      (result) => {
        if (!alive) return;
        if (!result.ok) setError(result.message);
        else setPrepared(result);
      },
      (err) => { if (alive) setError(err?.message || 'Could not read this output.'); },
    );
    return () => { alive = false; };
  }, [url]);

  // A staging left behind if this closes mid-flow. Harmless (it expires), but
  // plaintext should not sit around because somebody changed their mind.
  useEffect(() => () => {
    if (stagedToken.current && !posted) void dropCivitaiPost(stagedToken.current);
  }, [posted]);

  const post = useCallback(async () => {
    if (!prepared?.ok || prepared.problems.length) return;
    setPosting(true);
    setError('');
    try {
      const result = await stageCivitaiPost({
        blob: prepared.blob,
        filename,
        meta: postMetaFromEntry(entry, prepared),
        title: title.trim(),
        description: description.trim(),
        tags: normalizeTags(tags),
      });
      stagedToken.current = result.token;
      setPosted(result);
      // Civitai's composer needs the signed-in tab; opening it is the handoff.
      const opened = window.open(result.intentUrl, '_blank', 'noopener,noreferrer');
      if (!opened) {
        // A blocked popup is not a failure — the link is still good, and the
        // dialog now shows it as one to click.
        toast(zh() ? '浏览器拦截了新标签页，请点击下面的链接。' : 'Your browser blocked the new tab — use the link below.');
      }
    } catch (err) {
      setError(err?.message || 'Could not hand this to Civitai.');
    } finally {
      setPosting(false);
    }
  }, [prepared, entry, filename, title, description, tags]);

  // Same staging, same stamping — only the last step differs: the file is saved
  // here and attached by hand, because Civitai's page cannot fetch an http URL.
  const postManually = useCallback(async () => {
    if (!prepared?.ok || prepared.problems.length) return;
    setPosting(true);
    setError('');
    try {
      const result = await stageCivitaiPost({
        blob: prepared.blob,
        filename,
        meta: postMetaFromEntry(entry, prepared),
        title: title.trim(),
        description: description.trim(),
        tags: normalizeTags(tags),
      });
      // Same-origin download of the STAMPED copy, so the prompt travels inside
      // the file the way the Civitai extension (and their pending native
      // support) expects to find it.
      const anchor = document.createElement('a');
      anchor.href = result.mediaUrl;
      anchor.download = filename || 'creation';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setPosted({ ...result, manual: true, intentUrl: CIVITAI_UPLOAD_URL });
      window.open(CIVITAI_UPLOAD_URL, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err?.message || 'Could not prepare this for Civitai.');
    } finally {
      setPosting(false);
    }
  }, [prepared, entry, filename, title, description, tags]);

  const direct = canHandOffDirectly();
  const blocked = Boolean(prepared?.problems?.length);
  const tagList = normalizeTags(tags);
  const kind = prepared?.kind === 'video' ? 'video' : 'image';

  return (
    <Modal
      open
      onClose={onClose}
      title={zh() ? '发布到 Civitai' : 'Post to Civitai'}
      size="lg"
      footer={
        posted ? (
          <>
            <span className="mr-auto text-[11px] text-ink3">
              {zh() ? '已在 Civitai 打开，请在那里完成发布。' : 'Finish the post in the Civitai tab.'}
            </span>
            <Button
              variant="neutral"
              icon="external"
              onClick={() => window.open(posted.intentUrl, '_blank', 'noopener,noreferrer')}
            >
              {zh() ? '重新打开' : 'Reopen Civitai'}
            </Button>
            <Button variant="primary" icon="check" onClick={onClose}>{zh() ? '完成' : 'Done'}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" className="mr-auto" onClick={onClose}>{zh() ? '取消' : 'Cancel'}</Button>
            <Button
              variant="primary"
              icon="upload"
              loading={posting}
              disabled={!prepared?.ok || blocked || posting}
              onClick={() => void (direct ? post() : postManually())}
            >
              {direct
                ? (zh() ? '发布到 Civitai' : 'Continue to Civitai')
                : (zh() ? '保存并打开 Civitai' : 'Save file & open Civitai')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {!prepared && !error ? (
          <div className="flex items-center gap-2 py-6 text-xs text-ink3">
            <Spinner size={14} className="text-honey" />
            {zh() ? '正在读取该作品…' : 'Reading this creation…'}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-danger/40 bg-danger-tint p-3 text-xs text-danger">{error}</div>
        ) : null}

        {prepared?.ok ? (
          <>
            <div className="flex gap-3">
              <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-md border border-line1 bg-bg0">
                <Icon name={kind === 'video' ? 'video' : 'image'} size={18} className="text-ink3" />
              </div>
              <div className="flex min-w-0 flex-col gap-1 text-[11px] text-ink2">
                <span className="font-mono text-ink1">{filename}</span>
                <span>
                  {formatBytes(prepared.size)}
                  {prepared.width ? ` · ${prepared.width}×${prepared.height}` : ''}
                  {prepared.duration ? ` · ${Math.round(prepared.duration)}s` : ''}
                </span>
                {/* Named plainly. This is the one screen where the studio's
                    usual promise does not apply, so it says so. */}
                <span className="text-warn">
                  {zh()
                    ? '将以未加密的原始文件上传至 Civitai。'
                    : 'Uploaded to Civitai unencrypted — this is public once you publish it there.'}
                </span>
              </div>
            </div>

            {blocked ? (
              <div className="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger-tint p-3 text-xs text-danger">
                {prepared.problems.map((problem) => <span key={problem}>{problem}</span>)}
              </div>
            ) : null}

            {!posted ? (
              <>
                <Field label={zh() ? '标题' : 'Title'}>
                  <TextInput
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={zh() ? '可选' : 'Optional'}
                    maxLength={255}
                  />
                </Field>
                <Field label={zh() ? '描述' : 'Description'}>
                  <TextArea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={zh() ? '可选' : 'Optional'}
                    rows={3}
                    maxLength={1000}
                  />
                </Field>
                <Field
                  label={zh() ? '标签' : 'Tags'}
                  hint={zh()
                    ? `逗号分隔，最多 ${CIVITAI_LIMITS.tags} 个`
                    : `Comma separated · Civitai allows ${CIVITAI_LIMITS.tags}`}
                  labelRight={
                    <span className={cx('text-[10px]', tagList.length >= CIVITAI_LIMITS.tags ? 'text-warn' : 'text-ink3')}>
                      {tagList.length}/{CIVITAI_LIMITS.tags}
                    </span>
                  }
                >
                  <TextInput
                    value={tags}
                    onChange={(event) => setTags(event.target.value)}
                    placeholder="anime, landscape"
                  />
                </Field>

                {!direct ? (
                  <div className="rounded-md border border-line1 bg-bg2 p-2.5 text-[11px] leading-relaxed text-ink2">
                    <span className="font-medium text-ink1">
                      {zh() ? '此地址无法一键发布。' : 'One-click posting needs the secure address.'}
                    </span>{' '}
                    {zh()
                      ? '浏览器不允许 Civitai 的页面读取以 http:// 打开的本机地址，因此这里会把带元数据的文件保存到本地，并打开 Civitai 的上传页供你拖入。改用 https:// 的 Tailscale 地址即可一键完成。'
                      : 'Browsers will not let Civitai’s page read an http:// address, so this will save the file (with its metadata written in) and open Civitai’s uploader for you to drop it into. Open the studio on its https Tailscale address to post in one step.'}
                  </div>
                ) : null}

                <p className="text-[11px] leading-relaxed text-ink3">
                  {zh()
                    ? 'Civitai 没有上传 API，因此这里会把作品在本机短暂暂存，然后打开 Civitai 的发布页由其读取；提示词与生成参数会写入文件内部。发布前你仍可在 Civitai 上修改。'
                    : 'Civitai has no upload API, so the studio stages this file locally for a few minutes and opens Civitai’s own post composer to read it — the prompt and settings are written inside the file on the way. Nothing is published until you press post on Civitai.'}
                </p>
              </>
            ) : (
              <div className="flex flex-col gap-2 rounded-md border border-ok/40 bg-bg2 p-3 text-xs text-ink2">
                <span className="font-medium text-ink1">
                  {posted.manual
                    ? (zh() ? '文件已保存，Civitai 上传页已打开。' : 'File saved — Civitai’s uploader is open. Drop it in there.')
                    : (zh() ? 'Civitai 已打开该作品。' : 'Civitai has been opened with this creation.')}
                </span>
                <span>
                  {posted.metadataEmbedded
                    ? (zh()
                      ? '提示词与生成参数已写入文件内部。'
                      : 'The prompt and settings were written into the file.')
                    : (zh()
                      ? '未能将参数写入该文件，请在 Civitai 上手动填写提示词。'
                      : 'The settings could not be written into this file — add the prompt on Civitai by hand.')}
                </span>
                {/* Video metadata is real but not yet read by Civitai: their
                    own MP4/WebM detection is still an open PR, so saying
                    "embedded" without this would promise something that does
                    not happen on their side yet. */}
                {kind === 'video' && posted.metadataEmbedded ? (
                  <span className="text-ink3">
                    {zh()
                      ? 'Civitai 目前尚未原生读取视频元数据（相关 PR 仍在进行中），因此可能需要手动填写。'
                      : 'Civitai does not read video metadata natively yet (their PR for it is still open), so the fields there may still need filling in.'}
                  </span>
                ) : null}
                <span className="text-ink3">
                  {zh()
                    ? '本机暂存文件将在 30 分钟内自动删除。'
                    : 'The local staged copy is removed within 30 minutes.'}
                </span>
              </div>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
