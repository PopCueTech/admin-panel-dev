# PopCue AI Survey Generator Admin Panel

Simple GitHub Pages admin panel for generating surveys via AI.

## Files

- `index.html` - Survey creation form UI
- `style.css` - Responsive styling
- `app.js` - Authentication and API integration

## Setup

### 1. GitHub Pages Deployment

```bash
# Option 1: Create new repo
git clone https://github.com/YOUR_ORG/admin-panel.git
cd admin-panel

# Option 2: Add to existing repo
mkdir admin-panel
cd admin-panel
```

Copy the three files (index.html, style.css, app.js) to your deployment location.

### 2. Configure Backend URL

Already configured for production:

```javascript
const API_BASE_URL = 'https://popcue-api-812411253957.us-central1.run.app';
```

To change, edit `app.js` line 5 and update the URL.

### 3. Enable CORS on Backend

Add to your FastAPI `app/main.py`:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://your-github-pages-url.com"],  # Your GitHub Pages URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### 4. Deploy to GitHub Pages

In your GitHub repo settings:
1. Go to Settings > Pages
2. Select branch: `main` (or `gh-pages`)
3. Select folder: `/ (root)` or `/admin-panel`
4. Your panel will be live at: `https://YOUR_ORG.github.io/admin-panel`

## Usage

### Login
1. Enter your PopCue account email and password
2. Token is stored in browser localStorage

### Create Survey
1. **Name**: Survey title (5-500 chars)
2. **Description**: What survey tests (10-2000 chars)
3. **Context**: Detailed AI instructions (20-5000 chars)
4. **Points**: Reward amount (default 50)
5. **Organization**: Select tenant

### Example Context Prompt

```
Create 8 questions for a product test survey:
- First question: Purchase intent (5-point rating)
- Then 3 attribute questions (matrix: tasty, fresh, healthy, affordable)
- Then 2 MCQ questions on flavor preference
- End with optional feedback

Target demographic: millennial professionals, $50k+ income
Focus on: design appeal, pricing, sustainability features
```

## API Endpoint

**POST** `/api/v1/surveys/generate-ai`

### Request
```json
{
  "name": "Survey Title",
  "description": "What survey tests",
  "context": "Detailed requirements for AI",
  "points": 50,
  "tenant_id": "uuid"
}
```

### Response
```json
{
  "success": true,
  "survey_id": "uuid",
  "survey_version_id": "uuid",
  "questions_count": 8,
  "structure": { /* complete survey JSON */ },
  "ai_metadata": { /* generation details */ },
  "message": "Survey created successfully with 8 questions"
}
```

## Features

- ✅ Clean, responsive UI
- ✅ Character counters for form fields
- ✅ Real-time form validation
- ✅ Copy-to-clipboard survey IDs
- ✅ View full survey structure
- ✅ Display validation warnings
- ✅ Loading spinner during generation
- ✅ Toast notifications
- ✅ Dark mode support
- ✅ Mobile-friendly

## Environment Variables

None needed! Configure only:
- Backend URL in `app.js` (line 7)
- CORS origin in backend

## Troubleshooting

### "CORS error"
- Check backend CORS configuration
- Verify GitHub Pages URL is whitelisted

### "Login failed"
- Verify backend login endpoint works
- Check API_BASE_URL is correct

### "Failed to generate survey"
- Verify OPENAI_API_KEY is set on backend
- Check backend logs for detailed error

### "Invalid JSON response"
- Check OpenAI API is working
- Verify prompt is clear and detailed

## Future Enhancements

- Firebase authentication
- Save survey drafts
- Template library
- Survey cloning
- Multi-language support
