import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPromptLibraryItems,
  listPromptLibraryItems,
  savePromptLibraryItem,
} from '../promptLibrary';
import {
  clearWorkflowEncryptionKey,
  setWorkflowEncryptionKey,
} from '../workflowEncryption';

describe('promptLibrary', () => {
  beforeEach(async () => {
    setWorkflowEncryptionKey('prompt-library-test-key');
    await clearPromptLibraryItems();
  });

  afterEach(async () => {
    await clearPromptLibraryItems();
    clearWorkflowEncryptionKey();
    localStorage.clear();
  });

  it('saves and loads encrypted full prompts with attached loras', async () => {
    const saved = await savePromptLibraryItem({
      kind: 'full',
      title: 'Kitchen embrace',
      positive: 'wide composition, two people on sofa',
      negative: 'cropped head',
      mode: 'forge_couple',
      loras: [
        {
          name: 'characters/HimawariUzumaki_AnimaPreview3_byKonan.safetensors',
          strength: 1,
          clipStrength: 1,
          active: true,
        },
      ],
    });

    const items = await listPromptLibraryItems();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: saved.id,
      kind: 'full',
      title: 'Kitchen embrace',
      positive: 'wide composition, two people on sofa',
      negative: 'cropped head',
      mode: 'forge_couple',
    });
    expect(items[0].loras[0]).toMatchObject({
      name: 'characters/HimawariUzumaki_AnimaPreview3_byKonan.safetensors',
      strength: 1,
      active: true,
    });
  });

  it('updates an existing item instead of duplicating it', async () => {
    const saved = await savePromptLibraryItem({
      kind: 'part',
      title: 'old title',
      positive: 'old prompt',
      loras: [],
    });

    await savePromptLibraryItem({
      ...saved,
      title: 'new title',
      positive: 'new prompt',
    });

    const items = await listPromptLibraryItems();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: saved.id,
      kind: 'part',
      title: 'new title',
      positive: 'new prompt',
    });
  });
});
