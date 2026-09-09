import { useRef, useState } from 'react';
import { Database, Download, Upload } from 'lucide-react';
import { exportProgress, parseProgressBackup, type ProgressData } from '../lib/progress';
import type { Exercise } from '../lib/exercises';
import Modal from './Modal';

export default function ProgressModal({
  data,
  onRestore,
  onClose,
  readyExercises,
}: {
  data: ProgressData;
  onRestore: (data: ProgressData) => void;
  onClose: () => void;
  readyExercises: Exercise[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<ProgressData | null>(null);
  const [error, setError] = useState('');
  const completed = readyExercises.filter((item) => data.exercises[item.id]?.solved).length;
  const drafts = Object.keys(data.exercises).length;
  const submissions = Object.values(data.exercises).reduce(
    (total, value) => total + value.attempts.length,
    0,
  );
  function download() {
    try {
      const url = URL.createObjectURL(
        new Blob([exportProgress(data)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `code-practice-progress-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(String(reason));
    }
  }
  return (
    <Modal title="Your progress" onClose={onClose}>
      <div className="local-progress-hero">
        <Database size={28} />
        <h3>Your saved progress</h3>
        <p>
          Your drafts, completed exercises, submissions, and stars are saved in Neon. Pending
          changes also keep a browser recovery copy when storage is available.
        </p>
      </div>
      <dl className="progress-totals">
        <div>
          <dt>Solved</dt>
          <dd>
            {completed}
            <small> / {readyExercises.length}</small>
          </dd>
        </div>
        <div>
          <dt>Saved drafts</dt>
          <dd>{drafts}</dd>
        </div>
        <div>
          <dt>Recent submissions</dt>
          <dd>{submissions}</dd>
        </div>
      </dl>
      <p className="storage-explanation">
        Export a progress backup for an extra copy. The latest 20 submissions per exercise appear
        here; the database retains the submission archive. Stars are stored separately.
      </p>
      <div className="backup-actions">
        <button className="button primary" onClick={download}>
          <Download size={16} /> Export progress
        </button>
        <button className="button secondary" onClick={() => input.current?.click()}>
          <Upload size={16} /> Restore backup
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            if (file.size > 10 * 1024 * 1024)
              throw new Error('The backup must be smaller than 10 MB.');
            setPending(parseProgressBackup(await file.text()));
            setError('');
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not read this backup.');
          }
          event.target.value = '';
        }}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <div className="restore-confirm">
          <h3>Restore this progress?</h3>
          <p>
            This backup contains {Object.keys(pending.exercises).length} exercise records. Its
            drafts will replace matching drafts. Solved status and submissions are merged; other
            records and database archives are kept. Export first to keep a copy of your current
            drafts.
          </p>
          <div className="backup-actions">
            <button
              className="button primary"
              onClick={() => {
                onRestore(pending);
                onClose();
              }}
            >
              Restore progress
            </button>
            <button className="button secondary" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <p className="storage-footer">
        Original browser backups are retained after migration. Pending work is not database-saved
        until its save is confirmed.
      </p>
    </Modal>
  );
}
