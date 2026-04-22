# AI-Powered Public Speaking Coach

An intelligent coaching platform designed to help users improve their public speaking skills through real-time feedback and post-session performance analysis. This project combines speech analytics, body language tracking, facial expression recognition, and content evaluation to make personalized coaching more accessible and affordable.

## Overview

Public speaking is a valuable skill in academic, professional, and everyday settings, but many people do not receive enough structured feedback while practicing. This project addresses that gap by using AI to analyze both verbal and non-verbal communication during practice sessions. Users receive live prompts while speaking and a detailed report afterward to help them improve over time.

## Features

- Real-time speech feedback such as pace, pitch, clarity, and filler word detection
- Body language analysis including posture, gestures, and eye contact
- Facial expression and emotion detection
- Content relevance analysis using speech-to-text and semantic comparison
- Session summaries with scores and improvement suggestions
- Progress tracking across multiple practice sessions
- Cross-platform frontend built with React Native and Expo

## Tech Stack

### Frontend
- React Native
- Expo
- TypeScript

### Backend
- Node.js
- FastAPI
- Python

### AI / ML Tools
- OpenCV
- MediaPipe
- DeepFace
- Librosa
- Google Speech-to-Text
- Sentence Transformers

### Database
- MongoDB

## Project Structure

```bash
AI-Powered-Public-Speaking-Coach-main/
│── frontend/        # React Native / Expo frontend
│── backend/         # FastAPI + Python analysis services
│── assets/          # Images, icons, and media
│── README.md
