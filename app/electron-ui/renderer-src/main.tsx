import { hydrateRoot } from "react-dom/client"
import { App } from "./App"
import "./shadcn.css"

const root = document.getElementById("ui-root")
if (!root) throw new Error("ui_root_missing")
hydrateRoot(root, <App />)
