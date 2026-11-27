import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AiChatMessage,
  AiChatResponse,
  AiFeedbackStats,
  AiKeyLevel,
  AiPerfMetrics,
  AiReasoningMode,
  AiStreamEvent,
  AiStreamPhase,
  AiTradeIdea,
  ExchangeId,
  GeminiChartAnalysis,
  GeminiConfigStatus,
  MlQuantForecast,
  TimeframeId,
} from '../../../shared/types.ts';
import type { ChartDrawing } from '../chartDrawings.ts';

interface GeminiAnalysisPanelProps {
  exchange: ExchangeId;
  timeframe: TimeframeId;
  drawings: ChartDrawing[];
  savedOllamaModel?: string;
  onChangeOllamaModel?: (model: string) => void;
  savedOllamaBaseUrl?: string;
  onChangeOllamaBaseUrl?: (url: string) => void;
  onPlotLevel: (level: AiKeyLevel) => void;
  onPlotAllLevels: (levels: AiKeyLevel[]) => void;
  onPlotTradeIdea: (idea: AiTradeIdea) => void;
  onClearAiPlots: () => void;
  hasAiPlots: boolean;
  onClose: () => void;
}

function formatPerfTitle(perf: AiPerfMetrics): string {
  const parts: string[] = [];
  if (perf.tokensPerSec !== null) parts.push(`Generation: ${perf.tokensPerSec} tok/s`);
  if (perf.promptTokensPerSec != null) parts.push(`Prompt eval: ${perf.promptTokensPerSec} tok/s`);
  if (perf.evalTokens != null) parts.push(`Output tokens: ${perf.evalTokens}`);
  parts.push(`Total time: ${perf.durationSec}s`);
  return parts.join(' • ');
}

function formatPhaseLabel(phase: AiStreamPhase | null, isReport = false): string {
  switch (phase) {
    case 'loading_context':
      return 'Fetching live chart & orderbook…';
    case 'prompt_eval':
      return 'Evaluating prompt…';
    case 'thinking':
      return 'Reasoning in real time…';
    case 'generating':
      return isReport ? 'Structuring JSON report…' : 'Writing reply…';
    default:
      return 'Processing locally…';
  }
}

async function readAiSseStream(
  res: Response,
  onEvent: (ev: AiStreamEvent) => void
): Promise<void> {
  if (!res.body) {
    const data = (await res.json()) as { error?: string };
    if (data.error) onEvent({ type: 'error', error: data.error });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop() ?? '';
      for (const rawBlock of chunks) {
        for (const line of rawBlock.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonText = trimmed.slice(5).trim();
          if (!jsonText) continue;
          try {
            onEvent(JSON.parse(jsonText) as AiStreamEvent);
          } catch {
            // ignore malformed frame
          }
        }
      }
    }
    buf += decoder.decode();
    for (const line of buf.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonText = trimmed.slice(5).trim();
      if (!jsonText) continue;
      try {
        onEvent(JSON.parse(jsonText) as AiStreamEvent);
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const GeminiAnalysisPanel: React.FC<GeminiAnalysisPanelProps> = React.memo(({
  exchange,
  timeframe,
  drawings,
  savedOllamaModel,
  onChangeOllamaModel,
  savedOllamaBaseUrl,
  onChangeOllamaBaseUrl,
  onPlotLevel,
  onPlotAllLevels,
  onPlotTradeIdea,
  onClearAiPlots,
  hasAiPlots,
  onClose,
}) => {
  const [status, setStatus] = useState<GeminiConfigStatus | null>(null);
  const [ollamaModel, setOllamaModel] = useState<string>(
    savedOllamaModel || 'inkling-2-mini-hybrid'
  );
  const [ollamaUrl, setOllamaUrl] = useState<string>(
    savedOllamaBaseUrl || 'http://127.0.0.1:11435'
  );
  const [ollamaUrlInput, setOllamaUrlInput] = useState<string>(
    savedOllamaBaseUrl || 'http://127.0.0.1:11435'
  );
  const [showOllamaConfig, setShowOllamaConfig] = useState<boolean>(false);
  const [showPlaybook, setShowPlaybook] = useState<boolean>(false);
  const [tradingPlaybook, setTradingPlaybook] = useState<string>(() => {
    try {
      return localStorage.getItem('btc_ai_playbook_v1') || '';
    } catch {
      return '';
    }
  });
  const [reasoningMode, setReasoningMode] = useState<AiReasoningMode>(() => {
    try {
      return localStorage.getItem('btc_ai_reasoning_mode_v1') === 'fast' ? 'fast' : 'deep';
    } catch {
      return 'deep';
    }
  });
  const [feedbackStats, setFeedbackStats] = useState<AiFeedbackStats | null>(null);
  const [reportRated, setReportRated] = useState<'up' | 'down' | null>(null);
  const [mlForecast, setMlForecast] = useState<MlQuantForecast | null>(null);
  const [probingOllama, setProbingOllama] = useState<boolean>(false);
  const [lastPerf, setLastPerf] = useState<AiPerfMetrics | null>(null);

  const [includeOrderbook, setIncludeOrderbook] = useState<boolean>(true);
  const [includeDrawings, setIncludeDrawings] = useState<boolean>(true);
  const [customPrompt, setCustomPrompt] = useState<string>('');

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<GeminiChartAnalysis | null>(null);
  const [activeTab, setActiveTab] = useState<'trades' | 'patterns' | 'levels' | 'confluence'>(
    'trades'
  );
  const [reportPhase, setReportPhase] = useState<AiStreamPhase | null>(null);
  const [reportLiveThinking, setReportLiveThinking] = useState<string>('');
  const [reportLivePerf, setReportLivePerf] = useState<AiPerfMetrics | null>(null);
  const reportAbortRef = useRef<AbortController | null>(null);
  const reportThinkPreRef = useRef<HTMLPreElement | null>(null);

  // Interactive multi-turn Chat state
  const [panelMode, setPanelMode] = useState<'report' | 'chat'>('report');
  const [chatMessages, setChatMessages] = useState<AiChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [chatLoading, setChatLoading] = useState<boolean>(false);
  const [chatIncludeContext, setChatIncludeContext] = useState<boolean>(true);
  const [chatPhase, setChatPhase] = useState<AiStreamPhase | null>(null);
  const [liveChatThinking, setLiveChatThinking] = useState<string>('');
  const [liveChatReply, setLiveChatReply] = useState<string>('');
  const [liveChatPerf, setLiveChatPerf] = useState<AiPerfMetrics | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatThinkPreRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!loading && !chatLoading) {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    setElapsedSec(0);
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => window.clearInterval(id);
  }, [loading, chatLoading]);

  useEffect(() => {
    if (panelMode === 'chat' && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, chatLoading, liveChatThinking, liveChatReply, panelMode]);

  useEffect(() => {
    if (chatThinkPreRef.current) {
      chatThinkPreRef.current.scrollTop = chatThinkPreRef.current.scrollHeight;
    }
  }, [liveChatThinking]);

  useEffect(() => {
    if (reportThinkPreRef.current) {
      reportThinkPreRef.current.scrollTop = reportThinkPreRef.current.scrollHeight;
    }
  }, [reportLiveThinking]);

  useEffect(() => {
    return () => {
      chatAbortRef.current?.abort();
      reportAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (savedOllamaModel) setOllamaModel(savedOllamaModel);
  }, [savedOllamaModel]);

  useEffect(() => {
    if (savedOllamaBaseUrl) {
      setOllamaUrl(savedOllamaBaseUrl);
      setOllamaUrlInput(savedOllamaBaseUrl);
    }
  }, [savedOllamaBaseUrl]);

  const refreshStatus = useCallback(
    (overrideOllamaUrl?: string) => {
      const targetUrl = (overrideOllamaUrl ?? ollamaUrl).trim();
      setProbingOllama(true);
      const q = targetUrl ? `?ollamaUrl=${encodeURIComponent(targetUrl)}` : '';
      fetch(`/api/ai/status${q}`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: GeminiConfigStatus | null) => {
          if (!data) return;
          setStatus(data);
          if (data.ollamaModels.length > 0) {
            setOllamaModel((cur) => {
              if (data.ollamaModels.some((m) => m.name === cur)) return cur;
              const next = data.defaultOllamaModel || data.ollamaModels[0].name;
              onChangeOllamaModel?.(next);
              return next;
            });
          } else if (!savedOllamaModel && data.defaultOllamaModel) {
            setOllamaModel(data.defaultOllamaModel);
          }
        })
        .catch(() => {})
        .finally(() => setProbingOllama(false));
    },
    [ollamaUrl, savedOllamaModel, onChangeOllamaModel]
  );

  useEffect(() => {
    refreshStatus();
    fetch('/api/ai/feedback/stats', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: AiFeedbackStats | null) => {
        if (s) setFeedbackStats(s);
      })
      .catch(() => {});
  }, [refreshStatus]);

  // Fetch instant (<1ms) Layer-2 LightGBM Quant-ML forecast whenever exchange or timeframe changes
  useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/ai/ml-forecast?exchange=${encodeURIComponent(exchange)}&timeframe=${encodeURIComponent(timeframe)}`,
      { credentials: 'same-origin' }
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { available?: boolean; forecast?: MlQuantForecast | null } | null) => {
        if (!cancelled && data?.forecast) {
          setMlForecast(data.forecast);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [exchange, timeframe]);

  const handleReasoningModeChange = (mode: AiReasoningMode) => {
    setReasoningMode(mode);
    try {
      localStorage.setItem('btc_ai_reasoning_mode_v1', mode);
    } catch {
      // ignore
    }
  };

  const handleSavePlaybook = (text: string) => {
    setTradingPlaybook(text);
    try {
      localStorage.setItem('btc_ai_playbook_v1', text);
    } catch {
      // ignore
    }
  };

  const submitFeedback = async (payload: {
    kind: 'report' | 'chat';
    rating: 'up' | 'down';
    prompt: string;
    thinking?: string;
    response: string;
    priceAtGeneration?: number;
    chatIndex?: number;
  }) => {
    try {
      const res = await fetch('/api/ai/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          kind: payload.kind,
          rating: payload.rating,
          model: ollamaModel.trim() || 'local',
          exchange,
          timeframe,
          priceAtGeneration: payload.priceAtGeneration,
          prompt: payload.prompt,
          thinking: payload.thinking,
          response: payload.response,
        }),
      });
      if (res.ok) {
        const stats = (await res.json()) as AiFeedbackStats;
        setFeedbackStats(stats);
        if (payload.kind === 'report') {
          setReportRated(payload.rating);
        } else if (typeof payload.chatIndex === 'number') {
          setChatMessages((prev) =>
            prev.map((m, i) => (i === payload.chatIndex ? { ...m, feedback: payload.rating } : m))
          );
        }
      }
    } catch {
      // ignore
    }
  };

  const handleSelectPresetUrl = (u: string) => {
    setOllamaUrlInput(u);
    setOllamaUrl(u);
    onChangeOllamaBaseUrl?.(u);
    refreshStatus(u);
  };

  const handleSaveOllamaUrl = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = ollamaUrlInput.trim() || 'http://127.0.0.1:11435';
    setOllamaUrl(clean);
    onChangeOllamaBaseUrl?.(clean);
    setShowOllamaConfig(false);
    refreshStatus(clean);
  };

  const handleStopReport = () => {
    reportAbortRef.current?.abort();
  };

  const handleAnalyze = async () => {
    reportAbortRef.current?.abort();
    const controller = new AbortController();
    reportAbortRef.current = controller;

    setError(null);
    setLoading(true);
    setReportRated(null);
    setReportPhase('loading_context');
    setReportLiveThinking('');
    setReportLivePerf(null);

    try {
      const userDrawings = includeDrawings
        ? drawings
            .filter((d) => !d.id.startsWith('ai-'))
            .slice(-25)
            .map((d) => ({
              type: d.type,
              points: d.points,
              text: d.text,
            }))
        : undefined;

      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({
          exchange,
          timeframe,
          model: ollamaModel.trim() || 'qwen3-4b-local',
          ollamaBaseUrl: ollamaUrl.trim() || undefined,
          includeOrderbookAndDerivs: includeOrderbook,
          userDrawings,
          customPrompt: customPrompt.trim() || undefined,
          tradingPlaybook: tradingPlaybook.trim() || undefined,
          reasoningMode,
          stream: true,
        }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok && !contentType.includes('text/event-stream')) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        setError(errData.error || `Analysis failed (${res.status})`);
        return;
      }

      if (contentType.includes('text/event-stream')) {
        await readAiSseStream(res, (ev) => {
          if (ev.type === 'ml_forecast') {
            setMlForecast(ev.forecast);
          } else if (ev.type === 'status') {
            setReportPhase(ev.phase);
          } else if (ev.type === 'thinking') {
            setReportPhase('thinking');
            setReportLiveThinking((prev) => prev + ev.delta);
            if (ev.livePerf) {
              setReportLivePerf(ev.livePerf);
              if (ev.livePerf.tokensPerSec !== null) setLastPerf(ev.livePerf);
            }
          } else if (ev.type === 'content') {
            setReportPhase('generating');
            if (ev.livePerf) {
              setReportLivePerf(ev.livePerf);
              if (ev.livePerf.tokensPerSec !== null) setLastPerf(ev.livePerf);
            }
          } else if (ev.type === 'done') {
            const doneData = ev.result as GeminiChartAnalysis;
            setAnalysis(doneData);
            if (doneData.perf) setLastPerf(doneData.perf);
          } else if (ev.type === 'error') {
            setError(ev.error);
          }
        });
      } else {
        const data = (await res.json()) as GeminiChartAnalysis & { error?: string };
        if (data.error) {
          setError(data.error);
          return;
        }
        setAnalysis(data);
        if (data.perf) setLastPerf(data.perf);
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setError('Network error reaching backend /api/ai/analyze.');
      }
    } finally {
      reportAbortRef.current = null;
      setLoading(false);
      setReportPhase(null);
    }
  };

  const handleStopChat = () => {
    chatAbortRef.current?.abort();
  };

  const handleSendChat = async (overrideText?: string) => {
    const text = (overrideText ?? chatInput).trim();
    if (!text || chatLoading) return;

    chatAbortRef.current?.abort();
    const controller = new AbortController();
    chatAbortRef.current = controller;

    setError(null);
    const userMsg: AiChatMessage = { role: 'user', content: text, ts: Date.now() };
    const nextHistory = [...chatMessages, userMsg];
    setChatMessages(nextHistory);
    if (!overrideText) setChatInput('');
    setChatLoading(true);
    setChatPhase(chatIncludeContext ? 'loading_context' : 'prompt_eval');
    setLiveChatThinking('');
    setLiveChatReply('');
    setLiveChatPerf(null);

    let streamedThinking = '';
    let streamedReply = '';
    let streamedPerf: AiPerfMetrics | undefined;
    let committed = false;

    try {
      const userDrawings = includeDrawings
        ? drawings
            .filter((d) => !d.id.startsWith('ai-'))
            .slice(-25)
            .map((d) => ({ type: d.type, points: d.points, text: d.text }))
        : undefined;

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({
          exchange,
          timeframe,
          model: ollamaModel.trim() || 'qwen3-4b-local',
          ollamaBaseUrl: ollamaUrl.trim() || undefined,
          includeLiveContext: chatIncludeContext,
          includeOrderbookAndDerivs: includeOrderbook,
          userDrawings,
          tradingPlaybook: tradingPlaybook.trim() || undefined,
          reasoningMode,
          stream: true,
          messages: nextHistory.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok && !contentType.includes('text/event-stream')) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        setError(errData.error || `Chat failed (${res.status})`);
        return;
      }

      if (contentType.includes('text/event-stream')) {
        await readAiSseStream(res, (ev) => {
          if (ev.type === 'ml_forecast') {
            setMlForecast(ev.forecast);
          } else if (ev.type === 'status') {
            setChatPhase(ev.phase);
          } else if (ev.type === 'thinking') {
            streamedThinking += ev.delta;
            setChatPhase('thinking');
            setLiveChatThinking(streamedThinking);
            if (ev.livePerf) {
              streamedPerf = ev.livePerf;
              setLiveChatPerf(ev.livePerf);
              if (ev.livePerf.tokensPerSec !== null) setLastPerf(ev.livePerf);
            }
          } else if (ev.type === 'content') {
            streamedReply += ev.delta;
            setChatPhase('generating');
            setLiveChatReply(streamedReply);
            if (ev.livePerf) {
              streamedPerf = ev.livePerf;
              setLiveChatPerf(ev.livePerf);
              if (ev.livePerf.tokensPerSec !== null) setLastPerf(ev.livePerf);
            }
          } else if (ev.type === 'done') {
            const data = ev.result as AiChatResponse;
            committed = true;
            if (data.perf) setLastPerf(data.perf);
            setChatMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: data.reply,
                thinking: data.thinking,
                perf: data.perf,
                ts: data.generatedAt || Date.now(),
              },
            ]);
          } else if (ev.type === 'error') {
            setError(ev.error);
          }
        });
      } else {
        const data = (await res.json()) as AiChatResponse & { error?: string };
        if (data.error) {
          setError(data.error);
          return;
        }
        committed = true;
        if (data.perf) setLastPerf(data.perf);
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.reply,
            thinking: data.thinking,
            perf: data.perf,
            ts: data.generatedAt || Date.now(),
          },
        ]);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        if (!committed && (streamedReply.trim() || streamedThinking.trim())) {
          setChatMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: streamedReply.trim() || '(Stopped while reasoning)',
              thinking: streamedThinking.trim() || undefined,
              perf: streamedPerf,
              ts: Date.now(),
            },
          ]);
        }
      } else {
        setError('Network error reaching backend /api/ai/chat.');
      }
    } finally {
      chatAbortRef.current = null;
      setChatLoading(false);
      setChatPhase(null);
      setLiveChatThinking('');
      setLiveChatReply('');
      setLiveChatPerf(null);
    }
  };

  const biasClass =
    analysis?.marketBias === 'Bullish'
      ? 'ai-bias-bull'
      : analysis?.marketBias === 'Bearish'
        ? 'ai-bias-bear'
        : 'ai-bias-neutral';

  const activeModelLabel = ollamaModel || 'Local Model';

  return (
    <aside className="ai-drawer" aria-label="Local AI Technical Analysis">
      <div className="ai-drawer-head">
        <div className="ai-drawer-title">
          <span className="ai-sparkle">🖥</span>
          <strong>Local AI</strong>
          <span className="ai-ctx-pill">
            {exchange.toUpperCase()} • {timeframe.toUpperCase()}
          </span>
          {lastPerf && lastPerf.tokensPerSec !== null && (
            <span className="ai-tps-pill" title={formatPerfTitle(lastPerf)}>
              ⚡ {lastPerf.tokensPerSec} tok/s
            </span>
          )}
        </div>
        <div className="ai-head-actions">
          <button
            type="button"
            className={`ai-icon-btn ${showPlaybook || tradingPlaybook.trim() ? 'active' : ''}`}
            onClick={() => setShowPlaybook((v) => !v)}
            title="Edit your personal trading playbook rules (injected into every prompt)"
          >
            📋
          </button>
          <button
            type="button"
            className="ai-icon-btn"
            onClick={() => refreshStatus()}
            disabled={probingOllama}
            title="Refresh local models"
          >
            ↻
          </button>
          <button
            type="button"
            className={`ai-icon-btn ${showOllamaConfig ? 'active' : ''}`}
            onClick={() => setShowOllamaConfig((v) => !v)}
            title="Configure custom local AI server URL"
          >
            ⚙
          </button>
          <button type="button" className="ai-icon-btn" onClick={onClose} title="Close AI Panel">
            ✕
          </button>
        </div>
      </div>

      {/* Controls: Backend Preset, Model Selector, Report / Chat Mode */}
      <div className="ai-controls-box">
        <div className="ai-provider-tabs" aria-label="Local AI Backend">
          <button
            type="button"
            className={ollamaUrl.includes(':11435') ? 'active' : ''}
            onClick={() => handleSelectPresetUrl('http://127.0.0.1:11435')}
            title="Fast llama-server with reasoning budget (100% GPU for <=5GB models like qwen3-4b-local, Hybrid GPU+CPU for larger models)"
          >
            ⚡ Fast GPU (:11435)
          </button>
          <button
            type="button"
            className={ollamaUrl.includes(':11434') ? 'active' : ''}
            onClick={() => handleSelectPresetUrl('http://127.0.0.1:11434')}
            title="Standard Ollama daemon (:11434)"
          >
            Ollama (:11434)
          </button>
        </div>

        <div className="ai-row">
          {status?.ollamaModels && status.ollamaModels.length > 0 ? (
            <select
              className="ai-select"
              value={ollamaModel}
              onChange={(e) => {
                setOllamaModel(e.target.value);
                onChangeOllamaModel?.(e.target.value);
              }}
              title="Choose local model"
            >
              {!status.ollamaModels.some((m) => m.name === ollamaModel) && ollamaModel && (
                <option value={ollamaModel}>{ollamaModel}</option>
              )}
              {status.ollamaModels.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.sizeGb > 0 ? ` (${m.sizeGb} GB)` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="ai-select"
              value={ollamaModel}
              onChange={(e) => {
                setOllamaModel(e.target.value);
                onChangeOllamaModel?.(e.target.value);
              }}
              placeholder="Model (e.g. inkling-2-mini-hybrid)"
            />
          )}

          <span className={`ai-key-status ${status?.ollamaReachable ? 'ready' : 'missing'}`}>
            {probingOllama
              ? '… Checking'
              : status?.ollamaReachable
                ? `● Ready (${status.ollamaModels.length})`
                : '○ Offline'}
          </span>
        </div>

        {showOllamaConfig && (
          <form className="ai-key-box" onSubmit={handleSaveOllamaUrl}>
            <div className="ai-key-head">
              <span>Custom Local Server URL</span>
              <span className="text-muted">Ollama / llama-server</span>
            </div>
            <div className="ai-key-input-row">
              <input
                type="text"
                value={ollamaUrlInput}
                onChange={(e) => setOllamaUrlInput(e.target.value)}
                placeholder="http://127.0.0.1:11435"
              />
              <button type="submit" className="ai-mini-btn primary">
                Connect
              </button>
            </div>
            <span className="ai-key-note">
              Hybrid GPU+CPU runs on <code>:11435</code> (<code>npm run start:hybrid-ai</code>);
              standard Ollama runs on <code>:11434</code>.
            </span>
          </form>
        )}

        {showPlaybook && (
          <div className="ai-playbook-box">
            <div className="ai-key-head">
              <span>📋 Trading Playbook Rules</span>
              <span className="text-muted">Auto-saved locally</span>
            </div>
            <textarea
              rows={3}
              value={tradingPlaybook}
              onChange={(e) => handleSavePlaybook(e.target.value)}
              placeholder="e.g. Only take longs above 4H EMA21 with min 1:2 R:R; respect >150 BTC resting walls; avoid chasing when funding > 0.03%..."
            />
          </div>
        )}

        {status && (!status.ollamaReachable || status.ollamaModels.length === 0) && (
          <div className="ai-ollama-help">
            <strong>
              {!status.ollamaReachable
                ? `Local server not reachable at ${ollamaUrl}`
                : 'No local models detected'}
            </strong>
            <span>Start Hybrid GPU+CPU or Ollama:</span>
            <code>
              {ollamaUrl.includes(':11435')
                ? 'npm run start:hybrid-ai'
                : 'sudo systemctl enable --now ollama\nollama pull qwen2.5:7b'}
            </code>
          </div>
        )}

        <div className="ai-mode-tabs" role="tablist" aria-label="AI Mode">
          <button
            type="button"
            role="tab"
            aria-selected={panelMode === 'report'}
            className={panelMode === 'report' ? 'active' : ''}
            onClick={() => setPanelMode('report')}
          >
            📊 TA Report
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panelMode === 'chat'}
            className={panelMode === 'chat' ? 'active' : ''}
            onClick={() => setPanelMode('chat')}
          >
            💬 Chat {chatMessages.length > 0 ? `(${chatMessages.length})` : ''}
          </button>
        </div>

        <div className="ai-reasoning-toggle" aria-label="Reasoning Depth">
          <button
            type="button"
            className={reasoningMode === 'fast' ? 'active' : ''}
            onClick={() => handleReasoningModeChange('fast')}
            title="Skip thinking chain for instant 2-6s replies"
          >
            ⚡ Fast (Instant)
          </button>
          <button
            type="button"
            className={reasoningMode === 'deep' ? 'active' : ''}
            onClick={() => handleReasoningModeChange('deep')}
            title="Live visible reasoning chain for deeper trade analysis"
          >
            🧠 Deep Think
          </button>
        </div>

        <div className="ai-toggles-row">
          {panelMode === 'chat' && (
            <label className="ai-check">
              <input
                type="checkbox"
                checked={chatIncludeContext}
                onChange={(e) => setChatIncludeContext(e.target.checked)}
              />
              <span>Live Chart Data</span>
            </label>
          )}
          <label className="ai-check">
            <input
              type="checkbox"
              checked={includeOrderbook}
              onChange={(e) => setIncludeOrderbook(e.target.checked)}
            />
            <span>Orderbook + Funding</span>
          </label>
          <label className="ai-check">
            <input
              type="checkbox"
              checked={includeDrawings}
              onChange={(e) => setIncludeDrawings(e.target.checked)}
            />
            <span>Drawings ({drawings.filter((d) => !d.id.startsWith('ai-')).length})</span>
          </label>
        </div>

        {panelMode === 'report' && (
          <>
            <input
              type="text"
              className="ai-prompt-input"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Optional focus (e.g. breakout setups, scalp, my trendlines)..."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !loading) handleAnalyze();
              }}
            />

            <div className="ai-action-row">
              <button
                type="button"
                className="ai-analyze-btn"
                onClick={handleAnalyze}
                disabled={loading}
              >
                {loading
                  ? `Analyzing ${exchange.toUpperCase()} ${timeframe.toUpperCase()}…`
                  : `🖥 Analyze ${exchange.toUpperCase()} ${timeframe.toUpperCase()}`}
              </button>
              {hasAiPlots && (
                <button
                  type="button"
                  className="ai-mini-btn danger"
                  onClick={onClearAiPlots}
                  title="Remove AI-plotted levels & trade setups (keeps your own drawings)"
                >
                  Clear AI
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {error && <div className="ai-error-box">{error}</div>}

      {mlForecast && (
        <div
          className="ai-ml-card"
          title={`Walk-Forward LightGBM (${mlForecast.modelTimeframe.toUpperCase()}) • Trained on ${mlForecast.modelMeta.trainSamples.toLocaleString()} bars • OOS AUC ${mlForecast.modelMeta.oosDirectionAuc} • Brier ${mlForecast.modelMeta.oosBrierScore} • ${mlForecast.inferenceMs}ms`}
        >
          <div className="ai-ml-head">
            <span className="ai-ml-title">
              📈 Quant-ML ({mlForecast.modelTimeframe.toUpperCase()} · {mlForecast.horizonLabel})
            </span>
            <div className="ai-ml-badges">
              <span
                className={`ai-ml-bias ${
                  mlForecast.directionalBias === 'Bullish'
                    ? 'bull'
                    : mlForecast.directionalBias === 'Bearish'
                      ? 'bear'
                      : 'neutral'
                }`}
              >
                {mlForecast.directionalBias} ({mlForecast.conviction})
              </span>
              <span className="ai-ml-regime">{mlForecast.dominantRegime}</span>
            </div>
          </div>

          <div className="ai-ml-bar" aria-label="Triple-barrier directional probabilities">
            <div className="ai-ml-seg up" style={{ width: `${mlForecast.probUp}%` }} />
            <div className="ai-ml-seg chop" style={{ width: `${mlForecast.probChop}%` }} />
            <div className="ai-ml-seg down" style={{ width: `${mlForecast.probDown}%` }} />
          </div>

          <div className="ai-ml-probs">
            <span className="text-bid">▲ Up {mlForecast.probUp}%</span>
            <span className="text-muted">◆ Chop {mlForecast.probChop}%</span>
            <span className="text-ask">▼ Down {mlForecast.probDown}%</span>
          </div>

          <div className="ai-ml-range-row">
            <span>
              Expected {mlForecast.horizonLabel} Range:{' '}
              <strong>
                ${Math.round(mlForecast.expectedLow).toLocaleString()} – $
                {Math.round(mlForecast.expectedHigh).toLocaleString()}
              </strong>{' '}
              (±{(mlForecast.expectedRangePct / 2).toFixed(1)}%)
            </span>
            <span className="ai-ml-ms">
              {mlForecast.liveEval
                ? mlForecast.liveEval.directionalWinRatePct !== null
                  ? `Live ${mlForecast.liveEval.directionalWinRatePct}% (n=${mlForecast.liveEval.directionalGraded}) · `
                  : `Tracking ${mlForecast.liveEval.pendingCount} · `
                : ''}
              {mlForecast.inferenceMs}ms
            </span>
          </div>

          {mlForecast.topDrivers.length > 0 && (
            <div className="ai-quant-chips">
              {mlForecast.topDrivers.map((d) => (
                <span
                  key={d.name}
                  className={`ai-quant-chip ${
                    d.direction === 'bullish' ? 'bull' : d.direction === 'bearish' ? 'bear' : ''
                  }`}
                >
                  {d.label}: {d.valueText}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {panelMode === 'chat' ? (
        <div className="ai-chat-container">
          <div className="ai-chat-messages" ref={chatScrollRef}>
            {chatMessages.length === 0 && !chatLoading && (
              <div className="ai-chat-empty">
                <p>
                  Chat offline with <strong>{activeModelLabel}</strong> about{' '}
                  <strong>
                    {exchange.toUpperCase()} {timeframe.toUpperCase()}
                  </strong>
                  .
                </p>
                <div className="ai-quick-prompts">
                  {[
                    'Summarize the current trend & key S/R levels',
                    'What is the best Long/Short R:R setup right now?',
                    'What do the orderbook walls & funding rate signal?',
                    'Review my drawn levels on the chart',
                  ].map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="ai-quick-chip"
                      onClick={() => handleSendChat(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {chatMessages.map((msg, idx) => (
              <div key={idx} className={`ai-chat-bubble ${msg.role}`}>
                <div className="ai-chat-role">
                  <span>{msg.role === 'user' ? 'You' : activeModelLabel}</span>
                  <div className="ai-chat-meta-right">
                    {msg.perf && msg.perf.tokensPerSec !== null && (
                      <span className="ai-chat-tps" title={formatPerfTitle(msg.perf)}>
                        ⚡ {msg.perf.tokensPerSec} tok/s
                        {msg.perf.evalTokens ? ` · ${msg.perf.evalTokens}t` : ''}
                      </span>
                    )}
                    {msg.ts && (
                      <span>
                        {new Date(msg.ts).toLocaleTimeString([], {
                          hour12: false,
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                </div>
                {msg.thinking && (
                  <details className="ai-thinking-box">
                    <summary>💭 Reasoning</summary>
                    <pre>{msg.thinking}</pre>
                  </details>
                )}
                <div className="ai-chat-text">{msg.content}</div>
                {msg.role === 'assistant' && (
                  <div className="ai-feedback-row">
                    <span>
                      {msg.feedback
                        ? 'Saved to training log'
                        : feedbackStats && feedbackStats.totalSamples > 0
                          ? `Dataset: ${feedbackStats.totalSamples}`
                          : 'Rate for training'}
                    </span>
                    <div className="ai-feedback-btns">
                      <button
                        type="button"
                        className={`ai-fb-btn ${msg.feedback === 'up' ? 'active-up' : ''}`}
                        onClick={() =>
                          submitFeedback({
                            kind: 'chat',
                            rating: 'up',
                            prompt: chatMessages[idx - 1]?.content || '',
                            thinking: msg.thinking,
                            response: msg.content,
                            chatIndex: idx,
                          })
                        }
                        title="Save as good training example"
                      >
                        👍
                      </button>
                      <button
                        type="button"
                        className={`ai-fb-btn ${msg.feedback === 'down' ? 'active-down' : ''}`}
                        onClick={() =>
                          submitFeedback({
                            kind: 'chat',
                            rating: 'down',
                            prompt: chatMessages[idx - 1]?.content || '',
                            thinking: msg.thinking,
                            response: msg.content,
                            chatIndex: idx,
                          })
                        }
                        title="Flag as weak example for DPO training"
                      >
                        👎
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {chatLoading && (
              <div className="ai-chat-bubble assistant">
                <div className="ai-chat-role">
                  <span>{activeModelLabel}</span>
                  <div className="ai-chat-meta-right">
                    {liveChatPerf && liveChatPerf.tokensPerSec !== null && (
                      <span className="ai-chat-tps" title={formatPerfTitle(liveChatPerf)}>
                        ⚡ {liveChatPerf.tokensPerSec} tok/s
                        {liveChatPerf.evalTokens ? ` · ${liveChatPerf.evalTokens}t` : ''}
                      </span>
                    )}
                    <span className="ai-phase-pill">
                      {formatPhaseLabel(chatPhase)}
                      {elapsedSec > 0 ? ` ${elapsedSec}s` : ''}
                    </span>
                  </div>
                </div>

                {(liveChatThinking || chatPhase === 'thinking') && (
                  <div className="ai-thinking-box live">
                    <div className="ai-thinking-live-head">
                      <span className="ai-thinking-live-title">
                        <span className="ai-live-dot" />
                        💭 Reasoning {chatPhase === 'thinking' ? '(live)' : '(done)'}
                      </span>
                      {liveChatThinking && (
                        <span>
                          {liveChatThinking.trim().split(/\s+/).filter(Boolean).length} words
                        </span>
                      )}
                    </div>
                    <pre className="ai-thinking-live-pre" ref={chatThinkPreRef}>
                      {liveChatThinking}
                      {chatPhase === 'thinking' && <span className="ai-stream-cursor">▍</span>}
                    </pre>
                  </div>
                )}

                {liveChatReply ? (
                  <div className="ai-chat-text">
                    {liveChatReply}
                    {chatPhase === 'generating' && <span className="ai-stream-cursor">▍</span>}
                  </div>
                ) : (
                  !liveChatThinking && (
                    <div className="ai-chat-typing">
                      <div className="ai-spinner small" />
                      <span>{formatPhaseLabel(chatPhase)}</span>
                    </div>
                  )
                )}
              </div>
            )}
          </div>

          <div className="ai-chat-composer">
            <textarea
              className="ai-chat-input"
              rows={2}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={`Ask ${activeModelLabel} about BTC ${timeframe}... (Enter to send)`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendChat();
                }
              }}
            />
            <div className="ai-chat-composer-btns">
              {chatMessages.length > 0 && !chatLoading && (
                <button
                  type="button"
                  className="ai-mini-btn"
                  onClick={() => {
                    setChatMessages([]);
                    setError(null);
                  }}
                  title="Clear chat history"
                >
                  Clear
                </button>
              )}
              {chatLoading ? (
                <button
                  type="button"
                  className="ai-stop-btn"
                  onClick={handleStopChat}
                  title="Stop generation"
                >
                  ⏹ Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="ai-analyze-btn"
                  onClick={() => handleSendChat()}
                  disabled={!chatInput.trim()}
                >
                  Send ➤
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="ai-results-scroll">
          {!analysis && !loading && (
            <div className="ai-empty-state">
              <p>
                <strong>100% Local &amp; Offline AI TA</strong>
              </p>
              <p>
                Analyzes multi-timeframe candles (active TF + 4H + 1D), EMA/MA 50/100/200, RSI,
                MACD, Bollinger Bands, ATR, swing fractals, resting Bid/Ask orderbook walls,
                5-exchange funding rates, whale/liquidation flow, and your chart drawings.
              </p>
              <p>
                Click <strong>Analyze</strong> for structured patterns &amp; plottable R:R setups,
                or switch to <strong>💬 Chat</strong> for free-form Q&amp;A.
              </p>
            </div>
          )}

          {loading && (
            <div className="ai-live-report-box">
              <div className="ai-live-report-head">
                <div className="ai-live-report-status">
                  <div className="ai-spinner small" />
                  <span>
                    {formatPhaseLabel(reportPhase, true)}
                    {elapsedSec > 0 ? ` (${elapsedSec}s)` : ''}
                  </span>
                </div>
                <div className="ai-chat-meta-right">
                  {reportLivePerf && reportLivePerf.tokensPerSec !== null && (
                    <span className="ai-chat-tps" title={formatPerfTitle(reportLivePerf)}>
                      ⚡ {reportLivePerf.tokensPerSec} tok/s
                      {reportLivePerf.evalTokens ? ` · ${reportLivePerf.evalTokens}t` : ''}
                    </span>
                  )}
                  <button
                    type="button"
                    className="ai-stop-btn"
                    onClick={handleStopReport}
                    title="Stop analysis"
                  >
                    ⏹ Stop
                  </button>
                </div>
              </div>
              {(reportLiveThinking || reportPhase === 'thinking') && (
                <div className="ai-thinking-box live">
                  <div className="ai-thinking-live-head">
                    <span className="ai-thinking-live-title">
                      <span className="ai-live-dot" />
                      💭 Live Model Reasoning
                    </span>
                    {reportLiveThinking && (
                      <span>
                        {reportLiveThinking.trim().split(/\s+/).filter(Boolean).length} words
                      </span>
                    )}
                  </div>
                  <pre className="ai-thinking-live-pre" ref={reportThinkPreRef}>
                    {reportLiveThinking}
                    {reportPhase === 'thinking' && <span className="ai-stream-cursor">▍</span>}
                  </pre>
                </div>
              )}
            </div>
          )}

          {analysis && !loading && (
            <>
              <div className={`ai-summary-card ${biasClass}`}>
                <div className="ai-bias-row">
                  <span className={`ai-bias-pill ${biasClass}`}>{analysis.marketBias}</span>
                  <span className="ai-regime">{analysis.marketRegime}</span>
                  <strong className="ai-conf">{analysis.confidence}%</strong>
                </div>
                <p className="ai-summary-text">{analysis.summary}</p>
                {analysis.thinking && (
                  <details className="ai-thinking-box">
                    <summary>💭 Model Reasoning</summary>
                    <pre>{analysis.thinking}</pre>
                  </details>
                )}
                <div className="ai-snap-grid">
                  <div>
                    <span>RSI(14)</span>
                    <strong>{analysis.dataSnapshot.rsi14 ?? '—'}</strong>
                  </div>
                  <div>
                    <span>ATR(14)</span>
                    <strong>
                      {analysis.dataSnapshot.atr14 ? `$${analysis.dataSnapshot.atr14}` : '—'}
                    </strong>
                  </div>
                  <div>
                    <span>Book Imb</span>
                    <strong
                      className={
                        analysis.dataSnapshot.bookImbalancePct >= 0 ? 'text-bid' : 'text-ask'
                      }
                    >
                      {analysis.dataSnapshot.bookImbalancePct >= 0 ? '+' : ''}
                      {analysis.dataSnapshot.bookImbalancePct}%
                    </strong>
                  </div>
                  <div>
                    <span>Fund 8h</span>
                    <strong
                      className={
                        analysis.dataSnapshot.oiWeightedFunding8h >= 0 ? 'text-bid' : 'text-ask'
                      }
                    >
                      {analysis.dataSnapshot.oiWeightedFunding8h >= 0 ? '+' : ''}
                      {analysis.dataSnapshot.oiWeightedFunding8h}%
                    </strong>
                  </div>
                </div>
                {(analysis.dataSnapshot.pocPrice ||
                  analysis.dataSnapshot.htfAlignment ||
                  (analysis.dataSnapshot.rsiDivergence &&
                    analysis.dataSnapshot.rsiDivergence !== 'None') ||
                  analysis.dataSnapshot.liquiditySweep) && (
                  <div className="ai-quant-chips">
                    {analysis.dataSnapshot.pocPrice && (
                      <span className="ai-quant-chip">
                        POC ${analysis.dataSnapshot.pocPrice.toLocaleString()}
                      </span>
                    )}
                    {analysis.dataSnapshot.htfAlignment && (
                      <span
                        className={`ai-quant-chip ${
                          analysis.dataSnapshot.htfAlignment.startsWith('Bullish')
                            ? 'bull'
                            : analysis.dataSnapshot.htfAlignment.startsWith('Bearish')
                              ? 'bear'
                              : ''
                        }`}
                      >
                        {analysis.dataSnapshot.htfAlignment}
                      </span>
                    )}
                    {analysis.dataSnapshot.rsiDivergence &&
                      analysis.dataSnapshot.rsiDivergence !== 'None' && (
                        <span
                          className={`ai-quant-chip ${
                            analysis.dataSnapshot.rsiDivergence === 'Bullish' ? 'bull' : 'bear'
                          }`}
                        >
                          {analysis.dataSnapshot.rsiDivergence} RSI Div
                        </span>
                      )}
                    {analysis.dataSnapshot.liquiditySweep && (
                      <span
                        className={`ai-quant-chip ${
                          analysis.dataSnapshot.liquiditySweep.startsWith('Bullish')
                            ? 'bull'
                            : 'bear'
                        }`}
                      >
                        {analysis.dataSnapshot.liquiditySweep}
                      </span>
                    )}
                  </div>
                )}
                <div className="ai-feedback-row">
                  <span>
                    {reportRated
                      ? `Saved to training log (${feedbackStats?.totalSamples ?? 1})`
                      : `Train dataset: ${feedbackStats?.totalSamples ?? 0} samples`}
                  </span>
                  <div className="ai-feedback-btns">
                    <button
                      type="button"
                      className={`ai-fb-btn ${reportRated === 'up' ? 'active-up' : ''}`}
                      onClick={() =>
                        submitFeedback({
                          kind: 'report',
                          rating: 'up',
                          prompt: analysis.promptSnapshot || '',
                          thinking: analysis.thinking,
                          response: JSON.stringify(analysis),
                          priceAtGeneration: analysis.currentPrice,
                        })
                      }
                    >
                      👍 Good Setup
                    </button>
                    <button
                      type="button"
                      className={`ai-fb-btn ${reportRated === 'down' ? 'active-down' : ''}`}
                      onClick={() =>
                        submitFeedback({
                          kind: 'report',
                          rating: 'down',
                          prompt: analysis.promptSnapshot || '',
                          thinking: analysis.thinking,
                          response: JSON.stringify(analysis),
                          priceAtGeneration: analysis.currentPrice,
                        })
                      }
                    >
                      👎 Weak
                    </button>
                  </div>
                </div>
              </div>

              <div className="ai-subtabs">
                <button
                  type="button"
                  className={activeTab === 'trades' ? 'active' : ''}
                  onClick={() => setActiveTab('trades')}
                >
                  Trades ({analysis.tradeIdeas.length})
                </button>
                <button
                  type="button"
                  className={activeTab === 'patterns' ? 'active' : ''}
                  onClick={() => setActiveTab('patterns')}
                >
                  Patterns ({analysis.patterns.length})
                </button>
                <button
                  type="button"
                  className={activeTab === 'levels' ? 'active' : ''}
                  onClick={() => setActiveTab('levels')}
                >
                  Levels ({analysis.keyLevels.length})
                </button>
                <button
                  type="button"
                  className={activeTab === 'confluence' ? 'active' : ''}
                  onClick={() => setActiveTab('confluence')}
                >
                  Signals
                </button>
              </div>

              {activeTab === 'trades' && (
                <div className="ai-card-list">
                  {analysis.tradeIdeas.length === 0 && (
                    <div className="ai-muted-note">
                      No high-conviction trade setups detected right now.
                    </div>
                  )}
                  {analysis.tradeIdeas.map((idea, idx) => (
                    <div
                      key={`${idea.title}-${idx}`}
                      className={`ai-trade-card ${idea.direction === 'Long' ? 'long' : 'short'}`}
                    >
                      <div className="ai-trade-head">
                        <span
                          className={`ai-dir-tag ${idea.direction === 'Long' ? 'long' : 'short'}`}
                        >
                          {idea.direction.toUpperCase()}
                        </span>
                        <strong>{idea.title}</strong>
                        <span className="ai-rr-tag">{idea.riskReward}</span>
                      </div>
                      <div className="ai-trade-meta">
                        <span>{idea.setupType}</span>
                        <span>Conf: {idea.confidence}%</span>
                      </div>
                      <div className="ai-trade-grid">
                        <div>
                          <span>Entry Zone</span>
                          <strong>
                            ${idea.entryLow.toLocaleString()} – ${idea.entryHigh.toLocaleString()}
                          </strong>
                        </div>
                        <div>
                          <span>Stop Loss</span>
                          <strong className="text-ask">${idea.stopLoss.toLocaleString()}</strong>
                        </div>
                        <div className="ai-tp-row">
                          <span>Targets</span>
                          <strong className="text-bid">
                            {idea.takeProfits
                              .map((tp, i) => `TP${i + 1}: $${tp.toLocaleString()}`)
                              .join(' · ')}
                          </strong>
                        </div>
                      </div>
                      <p className="ai-card-desc">{idea.rationale}</p>
                      <p className="ai-inval">Invalidation: {idea.invalidation}</p>
                      <button
                        type="button"
                        className="ai-plot-btn"
                        onClick={() => onPlotTradeIdea(idea)}
                      >
                        📈 Plot Setup on Chart
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'patterns' && (
                <div className="ai-card-list">
                  {analysis.patterns.length === 0 && (
                    <div className="ai-muted-note">No distinct chart patterns detected.</div>
                  )}
                  {analysis.patterns.map((pat, idx) => (
                    <div key={`${pat.name}-${idx}`} className="ai-pattern-card">
                      <div className="ai-trade-head">
                        <span
                          className={`ai-dir-tag ${
                            pat.bias === 'Bullish'
                              ? 'long'
                              : pat.bias === 'Bearish'
                                ? 'short'
                                : 'neutral'
                          }`}
                        >
                          {pat.bias}
                        </span>
                        <strong>{pat.name}</strong>
                        <span className="ai-status-tag">{pat.status}</span>
                      </div>
                      <div className="ai-trade-meta">
                        <span>TF: {pat.timeframe}</span>
                        <span>Conf: {pat.confidence}%</span>
                      </div>
                      {(pat.targetPrice || pat.invalidationPrice) && (
                        <div className="ai-pat-prices">
                          {pat.targetPrice && (
                            <span className="text-bid">
                              Target: ${pat.targetPrice.toLocaleString()}
                            </span>
                          )}
                          {pat.invalidationPrice && (
                            <span className="text-ask">
                              Inval: ${pat.invalidationPrice.toLocaleString()}
                            </span>
                          )}
                        </div>
                      )}
                      <p className="ai-card-desc">{pat.description}</p>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'levels' && (
                <div className="ai-card-list">
                  {analysis.keyLevels.length > 0 && (
                    <button
                      type="button"
                      className="ai-plot-btn"
                      onClick={() => onPlotAllLevels(analysis.keyLevels)}
                    >
                      + Plot All {analysis.keyLevels.length} Key Levels on Chart
                    </button>
                  )}
                  {analysis.keyLevels.map((lv, idx) => (
                    <div key={`${lv.price}-${idx}`} className="ai-level-row">
                      <div className="ai-level-main">
                        <div className="ai-level-top">
                          <strong
                            className={
                              lv.type === 'Support'
                                ? 'text-bid'
                                : lv.type === 'Resistance'
                                  ? 'text-ask'
                                  : 'text-cyan'
                            }
                          >
                            ${lv.price.toLocaleString()}
                          </strong>
                          <span className="ai-level-type">{lv.type}</span>
                          <span className="ai-level-str">{lv.strength}</span>
                        </div>
                        <span className="ai-level-reason">{lv.reason}</span>
                      </div>
                      <button
                        type="button"
                        className="ai-mini-btn"
                        onClick={() => onPlotLevel(lv)}
                        title={`Plot horizontal level at $${lv.price}`}
                      >
                        + Plot
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'confluence' && (
                <div className="ai-card-list">
                  <div className="ai-conf-group">
                    <strong>Technical Indicators</strong>
                    <ul>
                      {analysis.confluence.technical.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="ai-conf-group">
                    <strong>Orderbook &amp; Liquidity</strong>
                    <ul>
                      {analysis.confluence.orderbook.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="ai-conf-group">
                    <strong>Derivatives &amp; Funding</strong>
                    <ul>
                      {analysis.confluence.derivatives.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <div className="ai-footer-meta">
                <div className="ai-footer-row">
                  <span>
                    {analysis.model} •{' '}
                    {new Date(analysis.generatedAt).toLocaleTimeString([], { hour12: false })}
                  </span>
                  {analysis.perf && analysis.perf.tokensPerSec !== null && (
                    <span className="ai-chat-tps" title={formatPerfTitle(analysis.perf)}>
                      ⚡ {analysis.perf.tokensPerSec} tok/s ({analysis.perf.durationSec}s)
                    </span>
                  )}
                </div>
                <p className="ai-risk-note">{analysis.riskWarning}</p>
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
});
