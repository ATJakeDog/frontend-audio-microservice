import logo from './logo.svg';
import './App.css';
import React, { useState } from 'react';

function App() {
  const [msg, setMsg] = useState("");

  const startModel = async (modelName) => {
    setMsg(`Отправка запроса для ${modelName}...`);
    try {
      const response = await fetch(`http://localhost:8080/api/tasks/start?modelName=${modelName}`, {
        method: 'POST'
      });
      const data = await response.text();
      setMsg(data);
    } catch (error) {
      setMsg("Ошибка подключения к серверу");
    }
  };

  return (
    <div style={{ textAlign: 'center', marginTop: '50px' }}>
      <h1>AI Model Dashboard</h1>
      <button onClick={() => startModel("whisper")} style={{ margin: '10px', padding: '10px' }}>Whisper</button>
      <button onClick={() => startModel("gan")} style={{ margin: '10px', padding: '10px' }}>GAN</button>
      <button onClick={() => startModel("denoise")} style={{ margin: '10px', padding: '10px' }}>Denoise</button>
      <p>Статус: {msg}</p>
    </div>
  );
}

export default App;
