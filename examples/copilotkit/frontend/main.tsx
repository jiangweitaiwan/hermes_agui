import { CloudLogin } from "./cloud-auth";
import { createRoot } from "react-dom/client";
import "@copilotkit/react-core/v2/styles.css";
import { AppShell } from "./workspace/AppShell";
import "./style.css";

createRoot(document.getElementById("root")!).render(<CloudLogin><AppShell /></CloudLogin>);
