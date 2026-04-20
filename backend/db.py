from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URI = "mongodb+srv://prachi:publicspeakingcoach@cluster0.oconolx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster00"

client = AsyncIOMotorClient(MONGO_URI)

db = client["public_speaking_coach"]
sessions_collection = db["sessions"]
users_collection = db["users"]