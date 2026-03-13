import logo from './logo.svg';
import React, { useState, useRef, useEffect } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';
import './App.css';

function App() {
  const [msg, setMsg] = useState("");
  const [file, setFile] = useState(null);
  const [taskId, setTaskId] = useState(null);
  const [processedData, setProcessedData] = useState(null);
  const waveformRef = useRef(null);
  const wavesurfer = useRef(null);

  // Опрос Supabase для получения результата
  useEffect(() => {
    let interval;
    if (taskId && !processedData) {
      interval = setInterval(async () => {
        const res = await fetch(`https://indfolgrefrdhmsyswus.supabase.co/rest/v1/tasks?id=eq.${taskId}`, {
          headers: { "apikey": "твой_ключ" }
        });
        const data = await res.json();
        if (data && data[0] && data[0].status === 'COMPLETED') {
          setProcessedData(data[0]);
          clearInterval(interval);
        }
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [taskId, processedData]);

  // Отрисовка волны, когда готовы данные
  useEffect(() => {
    if (processedData && waveformRef.current) {
      const wsRegions = RegionsPlugin.create();
      
      wavesurfer.current = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: 'violet',
        progressColor: 'purple',
        plugins: [wsRegions]
      });

      wavesurfer.current.load(processedData.processed_audio_url);

      wavesurfer.current.on('decode', () => {
        const changes = JSON.parse(processedData.changes_metadata || "[]");
        changes.forEach(change => {
          wsRegions.addRegion({
            start: change.start,
            end: change.end,
            color: 'rgba(255, 0, 0, 0.4)',
            drag: false,
            resize: false
          });
        });
      });
    }
    return () => { if (wavesurfer.current) wavesurfer.current.destroy(); }
  }, [processedData]);

  const startModel = async (modelName) => {
    if (!file) { setMsg("Сначала выберите аудиофайл!"); return; }
    setMsg(`Загрузка и отправка в ${modelName}...`);
    
    const formData = new FormData();
    formData.append("file", file);
    formData.append("modelName", modelName);

    try {
      const response = await fetch(`https://backend-audio-microservice.onrender.com/api/tasks/start`, {
        method: 'POST',
        body: formData
      });
      const data = await response.text();
      setMsg(data);
      // Извлекаем ID (предполагая ответ "Task started with ID: 15...")
      const idMatch = data.match(/ID:\s*(\d+)/);
      if (idMatch) setTaskId(idMatch[1]);
      setProcessedData(null); // Сброс
    } catch (error) {
      setMsg("Ошибка сервера");
    }
  };

  return (
    <div style={{ textAlign: 'center', marginTop: '50px' }}>
      <h1>AI Audio Processor (СРСП 2)</h1>
      <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files[0])} />
      <br/><br/>
      <button onClick={() => startModel("whisper")}>Whisper (Fade)</button>
      <button onClick={() => startModel("gan")}>GAN (Pitch)</button>
      <button onClick={() => startModel("denoise")}>Denoise (Db)</button>
      <p>Статус: {msg}</p>

      {processedData && (
        <div style={{ marginTop: '30px', padding: '20px' }}>
          <h3>Результат:</h3>
          <div ref={waveformRef} style={{ width: '80%', margin: '0 auto', border: '1px solid #ccc' }}></div>
          <button onClick={() => wavesurfer.current.playPause()}>Воспроизвести</button>
        </div>
      )}
    </div>
  );
}

export default App;