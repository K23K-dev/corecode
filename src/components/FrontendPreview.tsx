'use client';

import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { Exercise } from '../lib/exercises';

/** Displays the authored target, never the learner's editor contents. */
export default function FrontendPreview({ exercise }: { exercise: Exercise }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<string>();
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reset, setReset] = useState(0);
  const [height, setHeight] = useState(240);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [width, setWidth] = useState(0);
  const widths = exercise.preview?.widths ?? [];
  const viewportWidth = width || availableWidth;
  const scale = Math.min(1, availableWidth / viewportWidth);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    let active = true;
    setError(false);
    setReady(false);
    const query = new URLSearchParams({
      problemId: exercise.id,
      problemVersion: exercise.version ?? '',
    });
    fetch('/api/preview?' + query, { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Preview unavailable');
        const result = await response.json();
        if (typeof result.document !== 'string' || !result.document) {
          throw new Error('Preview unavailable');
        }
        if (active) setDocument(result.document);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [exercise.id, exercise.version, attempt]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setAvailableWidth(Math.max(1, Math.floor(entry.contentRect.width)));
    });
    if (canvas.current) observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function receive(event: MessageEvent) {
      const data = event.data;
      if (
        !frame.current ||
        event.source !== frame.current.contentWindow ||
        data?.type !== 'code-practice-preview' ||
        data.problemId !== exercise.id ||
        data.problemVersion !== exercise.version
      )
        return;
      if (data.status === 'error') setError(true);
      if (data.status === 'ready') {
        setReady(true);
        if (Number.isFinite(data.height)) setHeight(Math.max(160, Math.min(1200, data.height)));
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [exercise.id, exercise.version]);

  useEffect(() => {
    if (!document || ready || error) return;
    const timer = window.setTimeout(() => setError(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [document, ready, error, reset]);

  return (
    <section className="frontend-preview" aria-label="Target preview">
      <div className="frontend-preview-toolbar">
        <h2>Target preview</h2>
        <div className="frontend-preview-controls">
          {widths.length > 0 && (
            <select
              aria-label="Preview width"
              value={width}
              onChange={(event) => setWidth(Number(event.target.value))}
            >
              <option value={0}>Fit</option>
              {widths.map((value) => (
                <option key={value} value={value}>
                  {value}px
                </option>
              ))}
            </select>
          )}
          {scale < 1 && <span className="frontend-preview-scale">{Math.round(scale * 100)}%</span>}
          <button
            type="button"
            className="button quiet"
            aria-label="Reset target preview"
            disabled={!document || error}
            onClick={() => {
              setReady(false);
              setHeight(240);
              setReset((value) => value + 1);
            }}
          >
            <RotateCcw size={14} /> Reset
          </button>
        </div>
      </div>
      <div className="frontend-preview-stage">
        <div ref={canvas}>
          {error ? (
            <div className="frontend-preview-status" role="alert">
              <p>The target preview could not be loaded.</p>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setDocument(undefined);
                  setReset((value) => value + 1);
                  setAttempt((value) => value + 1);
                }}
              >
                Retry preview
              </button>
            </div>
          ) : (
            <>
              {!ready && (
                <p className="frontend-preview-status" role="status">
                  Loading target preview…
                </p>
              )}
              {document && (
                <div
                  className="frontend-preview-viewport"
                  style={{ height: height * scale, width: viewportWidth * scale }}
                >
                  <iframe
                    key={reset}
                    ref={frame}
                    title={`Target preview: ${exercise.title}`}
                    sandbox="allow-scripts allow-forms"
                    referrerPolicy="no-referrer"
                    srcDoc={document}
                    style={{ width: viewportWidth, height, transform: `scale(${scale})` }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <p className="frontend-preview-caption">{exercise.preview?.caption}</p>
    </section>
  );
}
