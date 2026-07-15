import { describe, expect, it } from 'vitest';
import {
  buildPromptAssistantReferenceImageStorageKey,
  getPromptAssistantReferenceImageRestoreErrorMessage,
} from '../promptAssistantReferenceImageStorage';

describe('prompt assistant reference image storage', () => {
  it('does not show a restore error while the workflow unlock is still pending', () => {
    expect(
      getPromptAssistantReferenceImageRestoreErrorMessage(
        new Error('Private workflow unlock required. Enter your ComfyUI Mobile unlock passphrase before saving or loading encrypted workflows.'),
        false,
      ),
    ).toBeNull();
    expect(
      getPromptAssistantReferenceImageRestoreErrorMessage(
        new Error('Could not decrypt workflow. Unlock ComfyUI Mobile with the same passphrase used when this workflow/image was saved.'),
        false,
      ),
    ).toBeNull();
  });

  it('explains stale encrypted reference images without implying the screen is locked', () => {
    expect(
      getPromptAssistantReferenceImageRestoreErrorMessage(
        new Error('Could not decrypt workflow. Unlock ComfyUI Mobile with the same passphrase used when this workflow/image was saved.'),
        true,
      ),
    ).toBe('Reference image could not be restored with the current unlock. Reattach the image to save a fresh encrypted copy.');
  });

  it('uses the workflow filename before transient session keys', () => {
    expect(
      buildPromptAssistantReferenceImageStorageKey({
        workflowFilename: 'Anima WAI Couple Turbo - Prompt Assistant',
        workflowKey: 'workflow-key',
        activeSessionId: 'session-id',
        nodeKey: 'assistant-1',
      }),
    ).toContain('Anima%20WAI%20Couple%20Turbo%20-%20Prompt%20Assistant');
  });
});
