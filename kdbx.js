/*

readKeePassFile(dataView, filePassword):

  Parameters:

    * dataView: a jDataView instance of the byte array
                representing a KeePass file
    * filePassword: the password (string) to open this file

  Returns: An array of objects whose fields are:

    * UserName
    * Password
    * Notes
    * Title
    * URL

Copyright 2013 Nam T. Nguyen
Distributed under the GPL license version 2 or later.

*/

EndOfHeader = 0;
Comment = 1;
CipherID = 2;
CompressionFlags = 3;
MasterSeed = 4;
TransformSeed = 5;
TransformRounds = 6;
EncryptionIV = 7;
ProtectedStreamKey = 8;
StreamStartBytes = 9;
InnerRandomStreamID = 10;

function assert(condition, message) {
  if (!condition) {
    throw message || "Assertion failed";
  }
}

// copied from https://developer.mozilla.org/en-US/docs/Using_XPath
// Evaluate an XPath expression aExpression against a given DOM node
// or Document object (aNode), returning the results as an array
// thanks wanderingstan at morethanwarm dot mail dot com for the
// initial work.
function evaluateXPath(aNode, aExpr) {
  var xpe = new XPathEvaluator();
  var nsResolver = xpe.createNSResolver(aNode.ownerDocument == null ?
    aNode.documentElement : aNode.ownerDocument.documentElement);
  var result = xpe.evaluate(aExpr, aNode, nsResolver, 0, null);
  var found = [];
  var res;
  while (res = result.iterateNext())
    found.push(res);
  return found;
}

function readKeePassFile(dataView, filePassword) {
	var sig1 = dataView.getUint32();
	var sig2 = dataView.getUint32();
	assert(sig1 == 0x9AA2D903, "Invalid version");
	assert(sig2 == 0xB54BFB67, "Invalid version");
  var fileVersion = dataView.getUint32();
  assert(fileVersion == 0x00030001, "Invalid file version");

  var header = {};
  while (true) {
    var fieldId = dataView.getUint8();
    var fieldSize = dataView.getUint16();
    var data = dataView.getString(fieldSize);
    if (fieldId == EndOfHeader) {
      break;
    }
    switch (fieldId) {
      case TransformRounds:
        var v = new jDataView(data, 0, data.length, true);
        header[fieldId] = v.getUint64();
        break;
      default:
        header[fieldId] = data;
    }
  }
  assert(header[MasterSeed].length == 32,
    "Master seed not 32 bytes");
  assert(header[TransformSeed].length == 32,
    "Transform seed not 32 bytes");
  assert(header[InnerRandomStreamID] == "\x02\x00\x00\x00",
    "Not Salsa20 CrsAlgorithm");
  //assert(CipherID for AES)

  var masterPassword = CryptoJS.SHA256(filePassword);
  var compositeKey = CryptoJS.SHA256(masterPassword);
  compositeKey = compositeKey.toString(CryptoJS.enc.Hex);
  //alert("Composite Key: " + compositeKey);
  var tmpKey = {};
  tmpKey[0] = CryptoJS.enc.Hex.parse(compositeKey.substring(0, 32));
  tmpKey[1] = CryptoJS.enc.Hex.parse(compositeKey.substring(32, 64));
  //alert(tmpKey[0]);
  //alert(tmpKey[1]);
  var key = CryptoJS.enc.Latin1.parse(header[TransformSeed]);
  var iv = CryptoJS.enc.Hex.parse((new Array(16)).join("\x00"));
  for (var i = 0; i < header[TransformRounds]; ++i) {
    for (var j = 0; j < 2; ++j) {
      var encrypted = CryptoJS.AES.encrypt(tmpKey[j], key,
        { mode: CryptoJS.mode.ECB, iv: iv,
          padding: CryptoJS.pad.NoPadding });
      tmpKey[j] = encrypted.ciphertext;
    }
    /* if (i == 0) {
      alert("tmpKey[0] " + i + " " + tmpKey[0]);
      alert("tmpKey[1] " + i + " " + tmpKey[1]);
    } */
  }
  tmpKey = CryptoJS.enc.Hex.parse(
    tmpKey[0].toString(CryptoJS.enc.Hex) +
    tmpKey[1].toString(CryptoJS.enc.Hex)
  );
  var transformedKey = CryptoJS.SHA256(tmpKey).toString(CryptoJS.enc.Hex);
  //alert("Transformed Key: " + transformedKey);
  var masterSeed = CryptoJS.enc.Latin1.parse(header[MasterSeed]);
  masterSeed = masterSeed.toString(CryptoJS.enc.Hex);
  var combinedKey = CryptoJS.enc.Hex.parse(masterSeed + transformedKey);
  //alert(combinedKey);
  var aesKey = CryptoJS.SHA256(combinedKey);
  //alert("AES Key: " + aesKey);
  var aesIV = CryptoJS.enc.Latin1.parse(header[EncryptionIV]);
  //alert("AES IV: " + aesIV);
  var encryptedData = dataView.getString();
  encryptedData = CryptoJS.enc.Latin1.parse(encryptedData);
  var cipherParams = CryptoJS.lib.CipherParams.create( {
    ciphertext: encryptedData,
  } );
  var decryptedData = CryptoJS.AES.decrypt(cipherParams, aesKey,
    { mode: CryptoJS.mode.CBC, iv: aesIV,
      padding: CryptoJS.pad.Pkcs7 } );
  //alert("Decrypted: " + decryptedData);
  decryptedData = decryptedData.toString(CryptoJS.enc.Latin1);

  dataView = new jDataView(decryptedData, 0, decryptedData.length, true);
  var decryptedStartBytes = dataView.getString(32);
  assert(decryptedStartBytes == header[StreamStartBytes],
    "Start bytes do not match");

  var gzipData = "";
  var blockId = 0;
  while (true) {
    assert(dataView.getUint32() == blockId, "Wrong block from gzip stream");
    ++blockId;
    var blockHash = dataView.getString(32);
    var blockSize = dataView.getUint32();
    if (blockSize == 0) {
      for (var i = 0; i < 32; ++i) {
        assert(blockHash[i] == "\x00", "blockHash not all zeroes");
      }
      break;
    }
    var blockData = dataView.getString(blockSize);
    var computedHash = CryptoJS.SHA256(CryptoJS.enc.Latin1.parse(blockData));
    assert(blockHash == computedHash.toString(CryptoJS.enc.Latin1),
      "Block hash does not match");
    gzipData += blockData;
  }
  // ignore first 10 bytes (GZip header)
  gzipData = gzipData.substring(10);
  var xmlData = zip_inflate(gzipData);
  assert(xmlData.indexOf("<?xml") == 0, "XML data is not valid");
  //alert(xmlData);
  var xml = (new DOMParser()).parseFromString(xmlData, "text/xml");
  var keepassEntries = new Array();
  var entries = evaluateXPath(xml, "//Entry");

  var hashedProtectedStreamKey = CryptoJS.SHA256(
    CryptoJS.enc.Latin1.parse(header[ProtectedStreamKey]));
  //alert("ProtectedStreamKey: " + hashedProtectedStreamKey);
  hashedProtectedStreamKey = hashedProtectedStreamKey.toString(
    CryptoJS.enc.Latin1);
  assert(hashedProtectedStreamKey.length == 32,
    "hashedProtectedStreamKey invalid");
  var salsaKey = new Array(32);
  for (var i = 0; i < 32; ++i) {
    salsaKey[i] = hashedProtectedStreamKey.charCodeAt(i) & 0xFF;
  }
  var iv = new Uint8Array([0xE8, 0x30, 0x09, 0x4B, 0x97, 0x20, 0x5D, 0x2A]);
  var salsa = new Salsa20(salsaKey, iv);

  for (var i in entries) {
    var keys = evaluateXPath(entries[i], "String/Key");
    var values = evaluateXPath(entries[i], "String/Value");
    assert(keys.length == values.length, "different key and value sizes");
    var properties = {};
    for (var j in keys) {
      properties[keys[j].textContent] = values[j].textContent;
    }
    var password = atob(properties["Password"]);
    var xorbuf = salsa.getBytes(password.length);
    //alert("xorbuf: " + xorbuf);
    var r = new Array();
    for (var i = 0; i < password.length; ++i) {
      r[i] = String.fromCharCode(password.charCodeAt(i) ^ xorbuf[i]);
    }
    properties["Password"] = r.join("");
    //alert("Password: " + properties["Password"]);
    keepassEntries.push(properties);
  }

  return keepassEntries;
}
