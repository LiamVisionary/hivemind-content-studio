// Settings > Privacy — what is sealed to your key, and what is only encrypted
// on this Mac.
//
// This panel exists because the sign-in gate used to promise more than the code
// delivers: "each workspace keeps its own encryption key, nothing in one can be
// opened from another". True of the vault and of sealed media, which are per
// account. Not true of run files — briefs, scripts, prompt lists — which are
// written with one process-wide cipher whose key lives in this Mac's keychain,
// where any process running as you can read it, and which the owner can read
// across workspaces. The gate now says the narrower true thing and points here
// for the detail, so somebody deciding what to keep in which workspace is
// deciding on the real boundary.
import { toast } from 'react-hot-toast';
import { useLang } from '../hooks/hooks.js';
import { clearOwnerHandoff, resetVaultSession } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { Button, SectionLabel } from '../ui/kit.jsx';

function Row({ icon, tone, title, items }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
      <Icon name={icon} size={18} className={`mt-0.5 shrink-0 ${tone}`} />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-tight text-ink1">{title}</p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {items.map((item) => (
            <li key={item} className="text-xs leading-relaxed text-ink2">{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function PrivacyPanel({ onClose }) {
  const { zh } = useLang();

  // Adding a workspace happens on the sign-in screen, which needs this session
  // closed first — the same lock the topbar button performs, so a half-signed-in
  // state is impossible either way.
  const addWorkspace = async () => {
    window.dispatchEvent(new Event('hivemind-owner-lock-broadcast'));
    clearOwnerHandoff();
    resetVaultSession();
    try {
      await fetch('/api/owner/lock', { method: 'POST' });
    } catch {
      toast.error(zh ? '无法锁定工作室 — 请重试' : 'Could not lock the studio — try again');
      return;
    }
    onClose?.();
    location.href = '/?workspace=new';
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <SectionLabel>{zh ? '你的密钥 vs 这台电脑' : 'Sealed to your key vs. to this Mac'}</SectionLabel>
        <p className="mt-1 text-xs leading-relaxed text-ink3">
          {zh
            ? '两种加密都在本机进行，但它们的钥匙不同 — 这决定了另一个工作区能看到什么。'
            : 'Both happen on this machine, but they are locked with different keys — which is what decides what another workspace can see.'}
        </p>
      </div>

      <Row
        icon="shield"
        tone="text-honey"
        title={zh ? '用你的密钥封存' : 'Sealed to your key'}
        items={[
          zh ? '你的媒体库：生成的图片与视频、上传的参考图、角色人设。'
            : 'Your library: generated images and clips, uploaded references, saved personas.',
          zh ? '保险库中的草稿与已保存项目。'
            : 'Drafts and saved projects held in your vault.',
          zh ? '只有你的口令或通行密钥能打开 — 这台电脑上的其他工作区无法读取。'
            : 'Opened only by your passphrase or passkey — another workspace on this Mac cannot read them.',
        ]}
      />

      <Row
        icon="lock"
        tone="text-ink2"
        title={zh ? '用这台电脑的密钥加密' : 'Encrypted with this Mac’s key'}
        items={[
          zh ? '运行文件：brief.yaml、script.md、图像提示词列表等制作中间文件。'
            : 'Run files: the brief, the script, the prompt lists a run writes as it works.',
          zh ? '密钥存放在本机钥匙串中，因此以你的身份运行的程序都能读取它们。'
            : 'The key is in this Mac’s keychain, so any program running as you can read them.',
          zh ? '工作室所有者可以看到所有工作区的运行记录。'
            : 'The studio owner can see runs from every workspace, not only their own.',
        ]}
      />

      <p className="text-xs leading-relaxed text-ink3">
        {zh
          ? '两者都不会以明文离开这台电脑：只有你明确发送到云端模型的内容才会外传。'
          : 'Neither leaves this computer in plain text. Only what you explicitly send to a cloud model does.'}
      </p>

      <div className="flex items-start justify-between gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
        <div className="min-w-0">
          <SectionLabel>{zh ? '工作区' : 'Workspaces'}</SectionLabel>
          <p className="mt-1 text-xs leading-relaxed text-ink3">
            {zh
              ? '每个工作区都有自己的媒体库和密钥。新建工作区在登录界面完成，因此会先锁定当前工作区。'
              : 'Each workspace has its own library and its own key. A new one is created on the sign-in screen, so this one is locked first.'}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={addWorkspace}>
          {zh ? '添加工作区' : 'Add a workspace'}
        </Button>
      </div>
    </div>
  );
}
