'use client';

import { useCallback, useEffect, useState } from 'react';

import { listModels, listSkills, type ModelCatalog, type SkillCatalog } from '@/lib/agent-api';

export type AgentCatalogState = {
  error: string;
  imageModels: ModelCatalog | null;
  brainModels: ModelCatalog | null;
  skills: SkillCatalog | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  videoModels: ModelCatalog | null;
};

const initialState: AgentCatalogState = {
  brainModels: null,
  error: '',
  imageModels: null,
  skills: null,
  status: 'idle',
  videoModels: null,
};

export function useAgentCatalogs(enabled: boolean) {
  const [state, setState] = useState(initialState);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState(initialState);
      return;
    }
    let active = true;
    setState((current) => ({ ...current, error: '', status: 'loading' }));
    void Promise.all([listSkills(), listModels('brain'), listModels('image'), listModels('video')])
      .then(([skills, brainModels, imageModels, videoModels]) => {
        if (!active) return;
        if (
          brainModels.catalog_revision !== imageModels.catalog_revision ||
          brainModels.catalog_revision !== videoModels.catalog_revision
        ) {
          throw new Error('模型目录正在更新，请刷新后重新选择');
        }
        setState({
          brainModels,
          error: '',
          imageModels,
          skills,
          status: 'ready',
          videoModels,
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setState({
          ...initialState,
          error: cause instanceof Error ? cause.message : '创作目录加载失败，请重试',
          status: 'error',
        });
      });
    return () => {
      active = false;
    };
  }, [enabled, reloadKey]);

  const reload = useCallback(() => setReloadKey((current) => current + 1), []);
  return { ...state, reload };
}
