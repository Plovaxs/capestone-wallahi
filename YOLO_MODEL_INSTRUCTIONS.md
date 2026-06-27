YOLO model local hosting instructions

If the app cannot load the YOLO face model from Hugging Face (401 Unauthorized), host it locally under `public/models/yolov8n-face`.

Recommended steps (requires Hugging Face account and token):

1. Install Python and pip if not present.
2. Install the Hugging Face Hub CLI:

   pip install huggingface_hub

3. Login with your token (keep token secret):

   huggingface-cli login

4. Download the model repository into the `public/models` folder:

   huggingface-cli repo download Xenova/yolov8n-face -o public/models/yolov8n-face

5. Confirm files exist under `public/models/yolov8n-face` (config.json, weights, etc.).
6. Start the dev server: `npm run dev` and the app will try local fallback `/models/yolov8n-face` automatically.

Alternative: If you cannot use HF CLI, manually place the model files (config.json, merges, weights) into `public/models/yolov8n-face`.

Security note: Do not commit model weights to public repositories if they contain licensed or private content.
