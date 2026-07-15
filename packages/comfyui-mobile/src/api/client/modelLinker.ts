import type { Workflow } from '../types';
import { comfyRoute } from './base';

export interface ModelLinkerModel {
  filename: string;
  path: string;
  relative_path?: string;
  category?: string;
  base_directory?: string;
}

export interface ModelLinkerMatch {
  model: ModelLinkerModel;
  filename: string;
  confidence: number;
  similarity?: number;
  effective_confidence?: number;
  hardware_profile?: string;
  hardware_score?: number;
  hardware_preferred?: boolean;
  hardware_recommended?: boolean;
  hardware_recommendation_id?: string;
  hardware_reasons?: string[];
}

export interface ModelLinkerDownloadSource {
  source: string;
  url: string;
  filename: string;
  directory?: string;
  size?: number;
  match_type?: string;
  confidence?: number;
  hardware_profile?: string;
  hardware_reason?: string;
  name?: string;
  type?: string;
}

export interface ModelLinkerNodeRef {
  node_id: number;
  node_type?: string;
  widget_index: number;
  original_path?: string;
  category?: string;
  subgraph_id?: string | null;
  subgraph_name?: string | null;
  is_top_level?: boolean;
}

export interface ModelLinkerRecommendation {
  id: string;
  profile: string;
  label?: string;
  reason?: string;
  category?: string;
  filename?: string;
  local_matches?: ModelLinkerModel[];
  download?: ModelLinkerDownloadSource;
}

export interface MissingModelLink {
  node_id: number;
  node_type?: string;
  widget_index: number;
  original_path: string;
  category?: string;
  workflow_url?: string;
  workflow_directory?: string;
  hardware_profile?: string;
  hardware_recommendations?: ModelLinkerRecommendation[];
  matches: ModelLinkerMatch[];
  download_source?: ModelLinkerDownloadSource;
  all_node_refs?: ModelLinkerNodeRef[];
}

export interface ModelLinkerAnalyzeResult {
  missing_models: MissingModelLink[];
  total_missing: number;
  total_models_analyzed: number;
  hardware_profile?: string;
}

export interface ModelLinkerResolution {
  node_id: number;
  widget_index: number;
  resolved_path: string;
  category?: string;
  resolved_model?: ModelLinkerModel;
  subgraph_id?: string | null;
  is_top_level?: boolean;
}

export interface ModelLinkerResolveResult {
  workflow: Workflow;
  success: boolean;
}

export interface ModelLinkerDownloadResult {
  success: boolean;
  download_id: string;
  filename: string;
  category: string;
  error?: string;
}

async function readJsonOrError<T>(response: Response, fallbackMessage: string): Promise<T> {
  const data = await response.json().catch(() => null) as (T & { error?: unknown }) | null;
  if (!response.ok) {
    throw new Error(
      typeof data?.error === 'string' && data.error.trim()
        ? data.error
        : fallbackMessage,
    );
  }
  return data as T;
}

export async function analyzeWorkflowModelLinks(workflow: Workflow): Promise<ModelLinkerAnalyzeResult> {
  const response = await fetch(comfyRoute('/model_linker/analyze'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ workflow }),
  });
  return readJsonOrError<ModelLinkerAnalyzeResult>(response, 'Failed to analyze workflow models');
}

export async function resolveWorkflowModelLinks(
  workflow: Workflow,
  resolutions: ModelLinkerResolution[],
): Promise<ModelLinkerResolveResult> {
  const response = await fetch(comfyRoute('/model_linker/resolve'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ workflow, resolutions }),
  });
  return readJsonOrError<ModelLinkerResolveResult>(response, 'Failed to relink workflow models');
}

export async function downloadModelLink(source: ModelLinkerDownloadSource): Promise<ModelLinkerDownloadResult> {
  const response = await fetch(comfyRoute('/model_linker/download'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      url: source.url,
      filename: source.filename,
      category: source.directory ?? 'checkpoints',
    }),
  });
  return readJsonOrError<ModelLinkerDownloadResult>(response, 'Failed to start model download');
}
