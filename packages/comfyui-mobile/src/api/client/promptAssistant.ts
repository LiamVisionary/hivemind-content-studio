import { comfyRoute } from './base';

export interface PromptAssistantGenerateRequest {
  idea: string;
  profile: string;
  context?: string;
  image_caption?: string;
  extra_instructions?: string;
  timeout_seconds?: number;
  seed?: number;
  profile_json_override?: string;
  helper_mode?: string;
  negative_prompt?: string;
  reference_image?: {
    data_url: string;
    name?: string;
  };
  active_loras?: PromptAssistantActiveLora[];
}

export interface PromptAssistantActiveLora {
  name: string;
  strength?: number | string;
  active?: boolean;
  node_id?: number;
  node_title?: string;
  node_type?: string;
}

export interface PromptAssistantGenerateResponse {
  prompt: string;
  negative_prompt: string;
  title: string;
  reason: string;
  raw_response: string;
  resolved_profile_json: string;
}

export async function generatePromptAssistantPrompt(
  request: PromptAssistantGenerateRequest,
): Promise<PromptAssistantGenerateResponse> {
  const response = await fetch(comfyRoute('/api/prompt_assistant/generate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(request),
  });

  const data = await response.json().catch(() => null) as
    | (Partial<PromptAssistantGenerateResponse> & { error?: unknown })
    | null;

  if (!response.ok) {
    throw new Error(
      typeof data?.error === 'string' && data.error.trim()
        ? data.error
        : 'Prompt generation failed',
    );
  }

  return {
    prompt: typeof data?.prompt === 'string' ? data.prompt : '',
    negative_prompt: typeof data?.negative_prompt === 'string' ? data.negative_prompt : '',
    title: typeof data?.title === 'string' ? data.title : '',
    reason: typeof data?.reason === 'string' ? data.reason : '',
    raw_response: typeof data?.raw_response === 'string' ? data.raw_response : '',
    resolved_profile_json:
      typeof data?.resolved_profile_json === 'string' ? data.resolved_profile_json : '',
  };
}
