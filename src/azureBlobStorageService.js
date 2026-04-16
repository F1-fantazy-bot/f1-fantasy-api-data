const { BlobServiceClient } = require('@azure/storage-blob');

const BLOB_NAME = 'f1-fantasy-api-data.json';

async function uploadDataToAzureStorage(data) {
  if (!data) {
    throw new Error('No data provided for upload');
  }

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;

  if (!connectionString || !containerName) {
    throw new Error('Missing required Azure storage configuration');
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(BLOB_NAME);

  const jsonData = JSON.stringify(data, null, 2);

  await blockBlobClient.upload(jsonData, jsonData.length, {
    blobHTTPHeaders: { blobContentType: 'application/json' },
  });

  console.log(`Data uploaded successfully to ${BLOB_NAME}`);
}

module.exports = { uploadDataToAzureStorage };
