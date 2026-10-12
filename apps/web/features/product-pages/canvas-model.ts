import { createContext } from 'react';
import type { Edge, Node } from '@xyflow/react';

export const CANVAS_STORAGE_KEY = 'ecom-forge-canvas-demo';

export type CanvasAttachment = {
  id: string;
  label: string;
  sourceNodeId: string;
};

export type CanvasNodeData = {
  attachments?: CanvasAttachment[];
  image?: string;
  kind: 'asset' | 'image' | 'text' | 'video';
  model?: string;
  prompt?: string;
  ratio?: string;
  runStatus: 'failed' | 'idle' | 'queued' | 'running' | 'succeeded';
  title: string;
};

export type CanvasNode = Node<CanvasNodeData>;

export type CanvasSnapshot = {
  edges: Edge[];
  nodes: CanvasNode[];
  revision: number;
  updatedAt: string;
};

export type RunRequest = { nodeId?: string; scope: 'node' | 'workflow' };

export type CanvasActions = {
  addAttachment: (targetNodeId: string) => void;
  requestRun: (request: RunRequest) => void;
};

export const CanvasActionsContext = createContext<CanvasActions | null>(null);

function attachment(id: string, sourceNodeId: string, label: string): CanvasAttachment {
  return { id, label, sourceNodeId };
}

export const initialNodes: CanvasNode[] = [
  {
    data: { image: '/demo/dress.jpg', kind: 'asset', runStatus: 'idle', title: '连衣裙原图' },
    id: 'asset-1',
    position: { x: 60, y: 210 },
    type: 'creative',
  },
  {
    data: {
      attachments: [attachment('a-asset-text', 'asset-1', '连衣裙原图')],
      kind: 'text',
      model: '文本理解模型',
      prompt: '分析服装轮廓、材质与适合的视觉方向',
      ratio: '1:1',
      runStatus: 'idle',
      title: '创意分析',
    },
    id: 'text-1',
    position: { x: 390, y: 100 },
    type: 'creative',
  },
  {
    data: {
      attachments: [
        attachment('a-asset-image', 'asset-1', '连衣裙原图'),
        attachment('a-text-image', 'text-1', '创意分析'),
      ],
      image: '/demo/result-1.jpg',
      kind: 'image',
      model: '图像模型',
      prompt: '电影感时装大片，自然风与流动裙摆',
      ratio: '3:4',
      runStatus: 'idle',
      title: '时装主视觉',
    },
    id: 'image-1',
    position: { x: 730, y: 180 },
    selected: true,
    type: 'creative',
  },
  {
    data: {
      attachments: [attachment('a-image-video', 'image-1', '时装主视觉')],
      image: '/demo/result-4.jpg',
      kind: 'video',
      model: '视频模型',
      prompt: '镜头从裙摆缓慢上移，人物转身',
      ratio: '9:16',
      runStatus: 'idle',
      title: '短片镜头',
    },
    id: 'video-1',
    position: { x: 1080, y: 120 },
    type: 'creative',
  },
];

export const initialEdges: Edge[] = [
  { animated: true, id: 'e-a-t', source: 'asset-1', target: 'text-1' },
  { id: 'e-a-i', source: 'asset-1', target: 'image-1' },
  { animated: true, id: 'e-t-i', source: 'text-1', target: 'image-1' },
  { animated: true, id: 'e-i-v', source: 'image-1', target: 'video-1' },
];

export function parseSnapshot(value: string | null): CanvasSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CanvasSnapshot>;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return {
      edges: parsed.edges,
      nodes: parsed.nodes,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function syncAttachments(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    const attachments = edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => {
        const source = nodeById.get(edge.source);
        return attachment(`attachment-${edge.id}`, edge.source, source?.data.title ?? '上游素材');
      });
    return { ...node, data: { ...node.data, attachments } };
  });
}
