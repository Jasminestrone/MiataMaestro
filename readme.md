# 🏎️ Miata Maestro

AI-powered marketplace scraper for finding perfect NA Miatas (1989-1997).

## Quick Start

```bash
git clone https://github.com/jasminestrone/MiataMaestro.git
cd MiataFinder
npm install
node main.js
```
optional
```bash
ollama run lamma3.1:8b
ollama serve
```

Then open http://localhost:3000 and start hunting!

## Requirements

- Node.js 16+
- Facebook account with Marketplace access
- Ollama (optional, for AI features)

## Documentation

**📖 Complete documentation available at `docs/index.html`**

The docs include:
- [Home Page](https://jasminestrone.github.io/MiataMaestro/index.html) - All encompassing guide 
- [Quick Start Guide](https://jasminestrone.github.io/MiataMaestro/quickstart.html) - Get running in 2 minutes
- [Complete Guide](https://jasminestrone.github.io/MiataMaestro/guide.html) - Features, setup, and usage
- [Troubleshooting](https://jasminestrone.github.io/MiataMaestro/troubleshooting.html) - Common issues and fixes
- [API Reference](https://jasminestrone.github.io/MiataMaestro/api.html) - Technical details

## Features

- **Smart Search**: Geographic filtering, year targeting, price/mileage limits
- **AI Analysis**: Market price estimates, condition assessment, lowball generation
- **Modern UI**: Glassmorphism design with real-time progress
- **Modular**: Clean 3-file architecture (`main.js`, `scraper.js`, `llm.js`)

## License

GNU GPLv3 - Built with ❤️ for the Miata community