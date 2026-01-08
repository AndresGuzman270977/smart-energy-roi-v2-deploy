import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // IMPORTANTE para que no salga “fondo sin datos” por rutas de assets
  base: "/"
});
