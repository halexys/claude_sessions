import { useState } from 'react';
import { setToken, getDeviceId } from './auth';
import { apiUrl } from './config';

export default function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          deviceId: getDeviceId(),
          deviceName: navigator.userAgent.includes('Android') ? 'Android' :
                      navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Navegador'
        })
      });
      const data = await res.json();
      if (res.ok) {
        setToken(data.token);
        onLogin();
      } else {
        setError(data.error || 'Error al registrar dispositivo');
      }
    } catch {
      setError('No se puede conectar al servidor');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-white text-2xl font-bold text-center mb-2">Claude Sessions</h1>
        <p className="text-slate-500 text-sm text-center mb-8">Primera vez en este dispositivo</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            autoFocus
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Contraseña"
            className="w-full bg-slate-800 text-white rounded-xl px-4 py-4 text-lg outline-none focus:ring-2 focus:ring-blue-500"
          />
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full bg-blue-600 disabled:bg-slate-700 text-white rounded-xl py-4 text-lg font-medium"
          >
            {loading ? 'Registrando...' : 'Registrar dispositivo'}
          </button>
        </form>
      </div>
    </div>
  );
}
