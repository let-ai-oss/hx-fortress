import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./storage.css";

// No StrictMode: the console clones a prototype with real timers and imperative
// flashes; double-invoked dev effects would change their observable behavior.
createRoot(document.getElementById("root")!).render(<App />);
