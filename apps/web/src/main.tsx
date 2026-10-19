import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CardGallery } from './CardGallery';
import './styles.css';

// Dev-only card gallery: ?preview=cards
const preview = import.meta.env.DEV && new URLSearchParams(location.search).get('preview') === 'cards';

createRoot(document.getElementById('root')!).render(<StrictMode>{preview ? <CardGallery /> : <App />}</StrictMode>);
