// the waitlist in mongodb, same two calls as waitlist-store.js:
//   add(email, meta) -> Promise<{ position, existing }>   count() -> Promise<number>   unsubscribe(email) -> Promise<{ found }>
// collection `waitlist`: { email (unique), position (unique), createdAt, source, ref, ua }.
// positions come from one counter doc (`counters`, _id 'waitlist') bumped with $inc, so two signups never share one.
// a signup that loses a race on the same email burns its number, so positions can skip; they never repeat.
// the driver is loaded lazily: without `npm install` or with the database down, the site still serves and only
// the waitlist calls fail.
export function openMongoStore(uri, dbName = 'madani') {
  let ready = null;
  const connect = () => {
    ready ??= (async () => {
      const { MongoClient } = await import('mongodb');
      const client = new MongoClient(uri, { appName: 'madani-site', maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });
      await client.connect();
      const db = client.db(dbName);
      const list = db.collection('waitlist');
      await list.createIndexes([
        { key: { email: 1 }, name: 'email_unique', unique: true },
        { key: { position: 1 }, name: 'position_unique', unique: true },
      ]);
      return { list, counters: db.collection('counters') };
    })().catch((err) => { ready = null; throw err; });
    return ready;
  };

  return {
    async add(email, { source = null, ref = null, ua = null } = {}) {
      const { list, counters } = await connect();
      const found = await list.findOne({ email }, { projection: { _id: 0, position: 1 } });
      if (found) return { position: found.position, existing: true };
      const { seq: position } = await counters.findOneAndUpdate(
        { _id: 'waitlist' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      try {
        await list.insertOne({ email, position, createdAt: new Date(), source, ref, ua });
        return { position, existing: false };
      } catch (err) {
        if (err?.code !== 11000) throw err;
        const raced = await list.findOne({ email }, { projection: { _id: 0, position: 1 } });
        if (!raced) throw err;
        return { position: raced.position, existing: true };
      }
    },
    async count() {
      const { list } = await connect();
      return list.countDocuments({});
    },
    // the entry stays; unsubscribedAt keeps its first value when a link is used twice
    async unsubscribe(email) {
      const { list } = await connect();
      const { matchedCount } = await list.updateOne({ email }, [{ $set: { unsubscribedAt: { $ifNull: ['$unsubscribedAt', '$$NOW'] } } }]);
      return { found: matchedCount === 1 };
    },
  };
}
