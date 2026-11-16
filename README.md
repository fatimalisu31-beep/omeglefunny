# VibeLink — Live Random Video & Text Chat

## Folder Structure
```text
vibelink/
├── package.json
├── server.js
└── public/
    └── index.html
```

## How to Run Locally
1. Install Node.js (v18+).
2. Open terminal in the `vibelink` folder and run:
   ```bash
   npm install
   npm start
   ```
3. Open `http://localhost:3000` in two browser tabs to test live matching!

## How to Publish Online for Free (Render.com)
1. Upload this `vibelink` folder to a GitHub repository.
2. Go to [Render.com](https://render.com) -> **New +** -> **Web Service**.
3. Connect your GitHub repo and set:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Deploy! Render will give you a live `https://` URL ready for everyone.
