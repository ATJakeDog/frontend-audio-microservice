import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';
import './App.css';

const BACKEND_API = process.env.REACT_APP_BACKEND_URL || 'https://backend-audio-microservice.onrender.com';

const MODEL_OPTIONS = [
  { key: 'whisper', label: 'Whisper', subtitle: 'Fade / transcription' },
  { key: 'gan', label: 'GAN', subtitle: 'Pitch shift / enhancement' },
  { key: 'denoise', label: 'Denoise', subtitle: 'Noise suppression' },
];

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED']);

const STATUS_PROGRESS = {
  UPLOADING: 10,
  PENDING: 20,
  PROCESSING: 35,
  COMPLETED: 100,
  FAILED: 100,
};

const createSelection = () => MODEL_OPTIONS.reduce((accumulator, model) => {
  accumulator[model.key] = true;
  return accumulator;
}, {});

const parseChanges = (changesMetadata) => {
  if (Array.isArray(changesMetadata)) {
    return changesMetadata;
  }

  if (changesMetadata == null) {
    return [];
  }

  let value = changesMetadata;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (Array.isArray(value)) {
      return value;
    }

    if (typeof value !== 'string') {
      return [];
    }

    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }

  return Array.isArray(value) ? value : [];
};

const normalizeTask = (task) => ({
  ...task,
  id: Number(task.id ?? task.taskId),
  progress: Number(task.progress ?? STATUS_PROGRESS[task.status] ?? 0),
});

const percentile = (values, ratio) => {
  if (values.length === 0) {
    return 0;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index];
};

function App() {
  const [msg, setMsg] = useState('Готов к загрузке');
  const [file, setFile] = useState(null);
  const [taskId, setTaskId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [selectedModels, setSelectedModels] = useState(createSelection);
  const [stressCount, setStressCount] = useState(20);
  const [stressRunning, setStressRunning] = useState(false);
  const waveformRef = useRef(null);
  const wavesurfer = useRef(null);

  const activeTask = tasks.find((task) => task.id === taskId) || tasks[0] || null;
  const activeProgress = activeTask ? (activeTask.progress ?? STATUS_PROGRESS[activeTask.status] ?? 0) : 0;
  const selectedTaskRegions = parseChanges(activeTask?.changesMetadata);

  const queuedTasks = tasks.filter((task) => !TERMINAL_STATUSES.has(task.status)).length;
  const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
  const failedTasks = tasks.filter((task) => task.status === 'FAILED').length;
  const dashboardProgress = tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0;

  const enabledModelKeys = MODEL_OPTIONS
    .filter((model) => selectedModels[model.key])
    .map((model) => model.key);

  const taskDurationsMs = tasks
    .filter((task) => task.status === 'COMPLETED' && task.createdAt && task.updatedAt)
    .map((task) => new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime())
    .filter((duration) => Number.isFinite(duration) && duration >= 0);

  const p50LatencyMs = percentile(taskDurationsMs, 0.5);
  const p95LatencyMs = percentile(taskDurationsMs, 0.95);
  const errorRate = tasks.length ? Math.round((failedTasks / tasks.length) * 100) : 0;
  const firstCreatedAt = tasks
    .map((task) => (task.createdAt ? new Date(task.createdAt).getTime() : null))
    .filter((value) => value !== null);
  const windowStart = firstCreatedAt.length ? Math.min(...firstCreatedAt) : null;
  const windowMinutes = windowStart ? Math.max((Date.now() - windowStart) / 60000, 1 / 60) : 1;
  const throughputPerMinute = tasks.length ? Math.round(completedTasks / windowMinutes) : 0;

  const mergeTask = (incomingTask) => {
    setTasks((previousTasks) => {
      const normalizedTask = {
        ...incomingTask,
        id: Number(incomingTask.id ?? incomingTask.taskId),
        progress: incomingTask.progress ?? STATUS_PROGRESS[incomingTask.status] ?? 0,
      };

      const nextTasks = previousTasks.filter((task) => task.id !== normalizedTask.id);
      return [normalizedTask, ...nextTasks];
    });
  };

  const submitTask = async (modelName) => {
    if (!file) {
      throw new Error('Сначала выберите аудиофайл');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('modelName', modelName);

    const response = await fetch(`${BACKEND_API}/api/tasks/start`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Ошибка запуска задачи');
    }

    return response.json();
  };

  const submitBatch = async () => {
    if (!file) {
      throw new Error('Сначала выберите аудиофайл');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('count', String(stressCount));
    formData.append('models', enabledModelKeys.join(','));

    const response = await fetch(`${BACKEND_API}/api/tasks/batch`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Ошибка batch-запуска');
    }

    return response.json();
  };

  const registerTask = (taskResult, modelName) => {
    const taskRecord = {
      id: taskResult.taskId,
      correlationId: taskResult.correlationId,
      modelName: taskResult.modelName || modelName,
      status: taskResult.status || 'UPLOADING',
      progress: taskResult.progress ?? 0,
      originalAudioUrl: null,
      processedAudioUrl: null,
      changesMetadata: '[]',
      createdAt: taskResult.createdAt || new Date().toISOString(),
      updatedAt: taskResult.updatedAt || new Date().toISOString(),
    };

    mergeTask(taskRecord);
    setTaskId(taskRecord.id);
  };

  const handleSingleRun = async (modelName) => {
    try {
      setMsg(`Отправка в ${modelName}...`);
      const taskResult = await submitTask(modelName);
      registerTask(taskResult, modelName);
      setMsg(taskResult.message || `Задача ${taskResult.taskId} отправлена`);
    } catch (error) {
      setMsg(error.message || 'Ошибка сервера');
    }
  };

  const handleRunSelectedModels = async () => {
    if (!file) {
      setMsg('Сначала выберите аудиофайл');
      return;
    }

    if (enabledModelKeys.length === 0) {
      setMsg('Выберите хотя бы одну модель');
      return;
    }

    setMsg(`Запускаю выбранные модели: ${enabledModelKeys.join(', ')}`);

    try {
      const results = await Promise.all(enabledModelKeys.map((modelName) => submitTask(modelName)));
      results.forEach((taskResult, index) => {
        registerTask(taskResult, enabledModelKeys[index]);
      });
      setMsg(`Запущено ${results.length} задач по выбранным моделям`);
    } catch (error) {
      setMsg(error.message || 'Ошибка запуска выбранных моделей');
    }
  };

  const handleStressRun = async () => {
    if (!file) {
      setMsg('Сначала выберите аудиофайл');
      return;
    }

    if (enabledModelKeys.length === 0) {
      setMsg('Выберите хотя бы одну модель');
      return;
    }

    setStressRunning(true);
    setMsg(`Stress Lab: запускаю ${stressCount} задач...`);

    try {
      const batchResult = await submitBatch();
      if (Array.isArray(batchResult.tasks)) {
        batchResult.tasks.forEach((taskResult) => {
          mergeTask(normalizeTask(taskResult));
        });
        setTaskId(Number(batchResult.tasks[0]?.taskId ?? batchResult.tasks[0]?.id ?? taskId));
      }
      setMsg(`Stress Lab: ${batchResult.count || stressCount} задач отправлено`);
    } catch (error) {
      setMsg(error.message || 'Stress Lab: ошибка запуска');
    } finally {
      setStressRunning(false);
    }
  };

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return undefined;
    }

    const eventSource = new EventSource(`${BACKEND_API}/api/tasks/stream`);

    eventSource.addEventListener('tasks', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (Array.isArray(payload.tasks)) {
          setTasks(payload.tasks.map(normalizeTask));
        }
      } catch (error) {
        console.warn('Failed to parse task stream', error);
      }
    });

    eventSource.onerror = () => {
      setMsg('Live stream temporarily unavailable, working from the last known snapshot.');
    };

    return () => {
      eventSource.close();
    };
  }, []);

  // Отрисовка волны, когда готовы данные
  useEffect(() => {
    if (!activeTask?.processedAudioUrl || !waveformRef.current) {
      return undefined;
    }

    const regions = parseChanges(activeTask?.changesMetadata);
    const regionsPlugin = RegionsPlugin.create();

    if (wavesurfer.current) {
      wavesurfer.current.destroy();
    }

    wavesurfer.current = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#ff8e72',
      progressColor: '#ff4f25',
      cursorColor: '#111111',
      barWidth: 2,
      barGap: 1,
      height: 180,
      normalize: true,
      plugins: [regionsPlugin],
    });

    wavesurfer.current.load(activeTask.processedAudioUrl);

    wavesurfer.current.on('decode', () => {
      regions.forEach((region) => {
        regionsPlugin.addRegion({
          start: region.start,
          end: region.end,
          color: 'rgba(255, 79, 37, 0.28)',
          drag: false,
          resize: false,
          content: region.type,
        });
      });
    });

    return () => {
      if (wavesurfer.current) {
        wavesurfer.current.destroy();
        wavesurfer.current = null;
      }
    };
  }, [activeTask?.id, activeTask?.processedAudioUrl, activeTask?.changesMetadata]);

  const selectedModelCount = enabledModelKeys.length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">FIELDWORK // AUDIO</div>
          <h1 className="brand-title">AI Audio Processor</h1>
        </div>
        <div className="topbar-chip">SYSTEM ONLINE</div>
      </header>

      <main className="dashboard-grid">
        <section className="hero-card panel-card">
          <div className="hero-copy">
            <p className="section-label">СРСП 3 // CONTROL PLANE</p>
            <h2>Индустриальный контур обработки аудио с реактивным управлением задачами.</h2>
            <p>
              Загрузка файлов, мультивыбор моделей, live-прогресс, WaveSurfer визуализация и отдельный Stress Lab для
              массовой проверки очереди.
            </p>
            <div className="hero-stats">
              <div>
                <strong>{tasks.length}</strong>
                <span>tasks total</span>
              </div>
              <div>
                <strong>{dashboardProgress}%</strong>
                <span>overall progress</span>
              </div>
              <div>
                <strong>{selectedModelCount}</strong>
                <span>models enabled</span>
              </div>
              <div>
                <strong>{throughputPerMinute}</strong>
                <span>throughput/min</span>
              </div>
            </div>
          </div>
          <div className="hero-actions">
            <button className="ghost-button" onClick={() => setMsg('Готово к новому запуску')}>
              System online
            </button>
            <span className="status-line">Статус: {msg}</span>
          </div>
        </section>

        <section className="workspace-grid">
          <div className="left-column">
            <section className="panel-card upload-card">
              <div className="panel-head">
                <span>01 // FILE</span>
                <span>{file ? file.name : 'no file selected'}</span>
              </div>

              <label className="upload-zone">
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] || null);
                    setMsg('Файл выбран');
                  }}
                />
                <div>
                  <strong>Перетащите аудиофайл или нажмите для выбора</strong>
                  <p>WAV, MP3, FLAC, M4A</p>
                </div>
              </label>

              <div className="model-grid">
                {MODEL_OPTIONS.map((model) => (
                  <button
                    key={model.key}
                    type="button"
                    className={`model-card ${selectedModels[model.key] ? 'active' : ''}`}
                    onClick={() => setSelectedModels((previous) => ({ ...previous, [model.key]: !previous[model.key] }))}
                  >
                    <span>{model.label}</span>
                    <small>{model.subtitle}</small>
                  </button>
                ))}
              </div>

              <div className="action-row">
                <button type="button" className="primary-button" onClick={handleRunSelectedModels}>
                  Run selected models ({selectedModelCount})
                </button>
                <button type="button" className="primary-button" onClick={() => handleSingleRun('whisper')}>
                  Quick run whisper
                </button>
                <button type="button" className="primary-button" onClick={() => handleSingleRun('gan')}>
                  Quick run gan
                </button>
              </div>
            </section>

            <section className="panel-card stress-card">
              <div className="panel-head">
                <span>02 // STRESS LAB</span>
                <span>{stressRunning ? 'running' : 'idle'}</span>
              </div>

              <div className="stress-controls">
                <label>
                  <span>Batch size</span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={stressCount}
                    onChange={(event) => setStressCount(Number(event.target.value) || 1)}
                  />
                </label>

                <div className="model-toggles">
                  {MODEL_OPTIONS.map((model) => (
                    <label key={model.key} className="toggle-item">
                      <input
                        type="checkbox"
                        checked={selectedModels[model.key]}
                        onChange={() => setSelectedModels((previous) => ({ ...previous, [model.key]: !previous[model.key] }))}
                      />
                      <span>{model.label}</span>
                    </label>
                  ))}
                </div>

                <button className="primary-button stress-launch" onClick={handleStressRun} disabled={stressRunning}>
                  {stressRunning ? 'Launching...' : `Run ${stressCount} random tasks`}
                </button>
              </div>

              <div className="metrics-grid">
                <div>
                  <strong>{queuedTasks}</strong>
                  <span>active</span>
                </div>
                <div>
                  <strong>{completedTasks}</strong>
                  <span>completed</span>
                </div>
                <div>
                  <strong>{failedTasks}</strong>
                  <span>failed</span>
                </div>
                <div>
                  <strong>{errorRate}%</strong>
                  <span>error rate</span>
                </div>
                <div>
                  <strong>{Math.round(p50LatencyMs / 1000)}s</strong>
                  <span>p50 latency</span>
                </div>
                <div>
                  <strong>{Math.round(p95LatencyMs / 1000)}s</strong>
                  <span>p95 latency</span>
                </div>
              </div>

              <div className="task-table">
                <div className="task-table-head">
                  <span>ID</span>
                  <span>MODEL</span>
                  <span>STATUS</span>
                  <span>PROGRESS</span>
                  <span></span>
                </div>

                {tasks.length === 0 && <div className="empty-state">Здесь появятся запуски и прогресс по ним.</div>}

                {tasks.map((task) => (
                  <div key={task.id} className={`task-row ${task.id === activeTask?.id ? 'selected' : ''}`}>
                    <span>#{task.id}</span>
                    <span>{task.modelName}</span>
                    <span className={`status-tag ${task.status?.toLowerCase()}`}>{task.status}</span>
                    <span>{task.progress ?? STATUS_PROGRESS[task.status] ?? 0}%</span>
                    <button className="link-button" onClick={() => setTaskId(task.id)}>
                      Open
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside className="right-column">
            <section className="panel-card live-card">
              <div className="panel-head">
                <span>03 // LIVE WORKSPACE</span>
                <span>{activeTask ? `task #${activeTask.id}` : 'no active task'}</span>
              </div>

              {activeTask ? (
                <>
                  <div className="live-summary">
                    <div>
                      <small>MODEL</small>
                      <strong>{activeTask.modelName}</strong>
                    </div>
                    <div>
                      <small>STATUS</small>
                      <strong>{activeTask.status}</strong>
                    </div>
                    <div>
                      <small>PROGRESS</small>
                      <strong>{activeProgress}%</strong>
                    </div>
                  </div>

                  <div className="progress-shell">
                    <div className="progress-bar" style={{ width: `${activeProgress}%` }} />
                  </div>

                  <div className="urls-grid">
                    <div>
                      <small>ORIGINAL</small>
                      <p>{activeTask.originalAudioUrl || 'waiting for upload'}</p>
                    </div>
                    <div>
                      <small>PROCESSED</small>
                      <p>{activeTask.processedAudioUrl || 'waiting for worker'}</p>
                    </div>
                  </div>

                  <div className="wave-compare">
                    <div>
                      <small>COMPARE</small>
                      <p>Original and processed audio are stored separately in Supabase; switch tasks to compare outputs.</p>
                    </div>
                  </div>

                  <div className="waveform-shell">
                    {activeTask.processedAudioUrl ? (
                      <div ref={waveformRef} className="waveform-canvas" />
                    ) : (
                      <div className="waveform-placeholder">
                        <span>Waveform will appear after processing finishes.</span>
                      </div>
                    )}
                  </div>

                  <div className="regions-list">
                    <span>Regions</span>
                    <div className="region-chips">
                      {selectedTaskRegions.length === 0 && <span className="region-chip muted">No regions yet</span>}
                      {selectedTaskRegions.map((region, index) => (
                        <span key={`${region.type}-${index}`} className="region-chip">
                          {region.type} {region.start}s → {region.end}s
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="playback-row">
                    <button className="primary-button" onClick={() => wavesurfer.current?.playPause()}>
                      Play / Pause
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty-state">Выберите задачу, чтобы открыть waveform и регионы.</div>
              )}
            </section>
          </aside>
        </section>
      </main>
    </div>
  );
}

export default App;