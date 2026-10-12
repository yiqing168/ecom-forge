'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  applyEdgeChanges,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
} from '@xyflow/react';

import {
  CANVAS_STORAGE_KEY,
  initialEdges,
  initialNodes,
  parseSnapshot,
  syncAttachments,
  type CanvasActions,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasSnapshot,
  type RunRequest,
} from '@/features/product-pages/canvas-model';
import { markAuthRedirect } from '@/lib/prototype-session';
import { getCurrentUser } from '@/lib/auth-api';

export function useCanvasEditorState() {
  const router = useRouter();
  const [edges, setEdges] = useEdgesState(initialEdges);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initialNodes);
  const [drawer, setDrawer] = useState<'history' | 'tasks' | null>(null);
  const [saved, setSaved] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [creationAllowed, setCreationAllowed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [runRequest, setRunRequest] = useState<RunRequest | null>(null);
  const [runMessage, setRunMessage] = useState('');
  const [remoteSnapshot, setRemoteSnapshot] = useState<CanvasSnapshot | null>(null);
  const revisionRef = useRef(0);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    let active = true;
    let removeMediaListener: () => void = () => undefined;
    void getCurrentUser()
      .then((result) => {
        if (!active) return;
        setAuthorized(true);
        setCreationAllowed(result.access.can_create);
        const snapshot = parseSnapshot(window.localStorage.getItem(CANVAS_STORAGE_KEY));
        if (snapshot) {
          setNodes(snapshot.nodes);
          setEdges(snapshot.edges);
          revisionRef.current = snapshot.revision;
        }
        setHydrated(true);

        const media = window.matchMedia('(max-width: 639px)');
        const updateMobile = () => setIsMobile(media.matches);
        updateMobile();
        media.addEventListener('change', updateMobile);
        removeMediaListener = () => media.removeEventListener('change', updateMobile);
      })
      .catch(() => {
        if (!active) return;
        markAuthRedirect();
        router.replace('/');
      });
    return () => {
      active = false;
      removeMediaListener();
    };
  }, [router, setEdges, setNodes]);

  useEffect(() => {
    if (!isMobile) return;
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
  }, [isMobile, setNodes]);

  useEffect(() => {
    if (!authorized || !hydrated) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      revisionRef.current += 1;
      const snapshot: CanvasSnapshot = {
        edges,
        nodes,
        revision: revisionRef.current,
        updatedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(snapshot));
      setSaved(true);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [authorized, edges, hydrated, nodes]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== CANVAS_STORAGE_KEY) return;
      const snapshot = parseSnapshot(event.newValue);
      if (snapshot && snapshot.revision > revisionRef.current) setRemoteSnapshot(snapshot);
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(
    () => () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const edge: Edge = {
        ...connection,
        animated: true,
        id: `edge-${crypto.randomUUID()}`,
      };
      setEdges((currentEdges) => {
        const nextEdges = addEdge(edge, currentEdges);
        setNodes((currentNodes) => syncAttachments(currentNodes, nextEdges));
        return nextEdges;
      });
    },
    [setEdges, setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((currentEdges) => {
        const nextEdges = applyEdgeChanges(changes, currentEdges);
        setNodes((currentNodes) => syncAttachments(currentNodes, nextEdges));
        return nextEdges;
      });
    },
    [setEdges, setNodes],
  );

  const addNode = useCallback(
    (kind: CanvasNodeData['kind']) => {
      const id = crypto.randomUUID();
      setNodes((current) => [
        ...current.map((node) => ({ ...node, selected: false })),
        {
          data: {
            attachments: [],
            kind,
            model: kind === 'video' ? '视频模型' : '图像模型',
            prompt: '',
            ratio: kind === 'video' ? '9:16' : '1:1',
            runStatus: 'idle',
            title:
              kind === 'text'
                ? '文本节点'
                : kind === 'video'
                  ? '视频节点'
                  : kind === 'asset'
                    ? '上传素材'
                    : '图片节点',
          },
          id,
          position: { x: 440 + current.length * 24, y: 260 + current.length * 18 },
          selected: !isMobile,
          type: 'creative',
        },
      ]);
    },
    [isMobile, setNodes],
  );

  const addAttachment = useCallback(
    (targetNodeId: string) => {
      const target = nodes.find((node) => node.id === targetNodeId);
      if (!target) return;
      const sourceNodeId = crypto.randomUUID();
      const edgeId = `edge-${crypto.randomUUID()}`;
      const label = `参考素材 ${(target.data.attachments?.length ?? 0) + 1}`;
      const sourceNode: CanvasNode = {
        data: {
          attachments: [],
          image: '/demo/dress-detail.jpg',
          kind: 'asset',
          runStatus: 'idle',
          title: label,
        },
        id: sourceNodeId,
        position: { x: target.position.x - 330, y: target.position.y + 150 },
        type: 'creative',
      };
      const edge: Edge = { animated: true, id: edgeId, source: sourceNodeId, target: targetNodeId };
      setEdges((currentEdges) => [...currentEdges, edge]);
      setNodes((currentNodes) =>
        syncAttachments(
          [
            ...currentNodes.map((node) => ({ ...node, selected: node.id === targetNodeId })),
            sourceNode,
          ],
          [...edges, edge],
        ),
      );
    },
    [edges, nodes, setEdges, setNodes],
  );

  const updateRunStatus = useCallback(
    (nodeIds: string[], runStatus: CanvasNodeData['runStatus']) => {
      setNodes((current) =>
        current.map((node) =>
          nodeIds.includes(node.id) ? { ...node, data: { ...node.data, runStatus } } : node,
        ),
      );
    },
    [setNodes],
  );

  const executeRun = useCallback(() => {
    if (!runRequest) return;
    if (!creationAllowed) {
      setRunRequest(null);
      setDrawer('tasks');
      setRunMessage('请先完成邮箱验证，再运行工作流');
      return;
    }
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    setRunRequest(null);
    setDrawer('tasks');

    if (runRequest.scope === 'node' && runRequest.nodeId) {
      updateRunStatus([runRequest.nodeId], 'running');
      setRunMessage('节点已通过编译校验，正在运行');
      timersRef.current.push(
        window.setTimeout(() => {
          updateRunStatus([runRequest.nodeId!], 'succeeded');
          setRunMessage('节点运行完成');
        }, 1100),
      );
      return;
    }

    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
    edges.forEach((edge) => {
      if (!indegree.has(edge.source) || !indegree.has(edge.target)) return;
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
      outgoing.get(edge.source)?.push(edge.target);
    });
    const queue = [...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id);
    const order: string[] = [];
    while (queue.length) {
      const current = queue.shift()!;
      order.push(current);
      outgoing.get(current)?.forEach((target) => {
        const next = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, next);
        if (next === 0) queue.push(target);
      });
    }

    if (order.length !== nodes.length) {
      const cycleNodes = nodes.filter((node) => !order.includes(node.id)).map((node) => node.id);
      updateRunStatus(cycleNodes, 'failed');
      setEdges((current) =>
        current.map((edge) =>
          cycleNodes.includes(edge.source) && cycleNodes.includes(edge.target)
            ? { ...edge, animated: false, style: { stroke: 'var(--danger)', strokeWidth: 2 } }
            : edge,
        ),
      );
      setRunMessage('检测到循环依赖，已高亮相关节点和连线');
      return;
    }

    updateRunStatus(order, 'queued');
    setRunMessage(`已通过环、引用和上游就绪校验，共 ${order.length} 个节点`);
    order.forEach((nodeId, index) => {
      timersRef.current.push(
        window.setTimeout(() => updateRunStatus([nodeId], 'running'), index * 500 + 250),
        window.setTimeout(
          () => {
            updateRunStatus([nodeId], 'succeeded');
            if (index === order.length - 1) setRunMessage('工作流运行完成');
          },
          index * 500 + 650,
        ),
      );
    });
  }, [creationAllowed, edges, nodes, runRequest, setEdges, updateRunStatus]);

  const canvasActions = useMemo<CanvasActions>(
    () => ({ addAttachment, requestRun: setRunRequest }),
    [addAttachment],
  );

  const nodeColor = useCallback(
    (node: CanvasNode) =>
      node.data.kind === 'video'
        ? 'var(--accent)'
        : node.data.kind === 'text'
          ? 'var(--info)'
          : 'var(--primary)',
    [],
  );

  function loadRemoteSnapshot() {
    if (!remoteSnapshot) return;
    setNodes(remoteSnapshot.nodes);
    setEdges(remoteSnapshot.edges);
    revisionRef.current = remoteSnapshot.revision;
    setRemoteSnapshot(null);
  }

  function saveAsCopy() {
    const copyKey = `${CANVAS_STORAGE_KEY}-copy-${Date.now()}`;
    window.localStorage.setItem(
      copyKey,
      JSON.stringify({ edges, nodes, revision: 1, updatedAt: new Date().toISOString() }),
    );
    setRemoteSnapshot(null);
    setRunMessage('已另存为副本，当前画布保留');
    setDrawer('history');
  }

  function simulateConflict() {
    setRemoteSnapshot({
      edges,
      nodes,
      revision: revisionRef.current + 1,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    addNode,
    authorized,
    canvasActions,
    drawer,
    edges,
    executeRun,
    isMobile,
    loadRemoteSnapshot,
    nodeColor,
    nodes,
    onConnect,
    onEdgesChange,
    onNodesChange,
    remoteSnapshot,
    router,
    runMessage,
    runRequest,
    saveAsCopy,
    saved,
    setDrawer,
    setRemoteSnapshot,
    setRunRequest,
    simulateConflict,
  };
}
