export async function mergeIntoDatabase(results) {
  for (const entry of results) {
    // TODO: connect to your DB
    // TODO: upsert by appId
    console.log("Merging:", entry.appId);
  }
}
