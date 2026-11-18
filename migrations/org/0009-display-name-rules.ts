import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * The API checks with the runtime's Unicode (Node 24.11 is Unicode 16), so
 * the API and this check can disagree on code points assigned since; the
 * API maps a violation of this check to its 400 (AccountService).
 *
 * Code point sets frozen from Unicode 18 (generated with Node's \p{…}
 * classes, the same ones src/modules/org/common/display-text.ts uses):
 * hex ranges `a-b`, comma-separated.
 */
// \p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point} and U+2800 (NUL cannot be stored)
const INVISIBLE =
  '1-1f,7f-9f,ad,34f,600-605,61c,6dd,70f,890-891,8e2,115f-1160,17b4-' +
  '17b5,180b-180f,200b-200f,2028-202e,2060-206f,2800,3164,fe00-' +
  'fe0f,feff,ffa0,fff0-fffb,110bd,110cd,13430-1343f,1bca0-1bca3,1d173-' +
  '1d17a,e0000-e0fff';
// \p{L}\p{N}
const LETTER_OR_DIGIT =
  '30-39,41-5a,61-7a,aa,b2-b3,b5,b9-ba,bc-be,c0-d6,d8-f6,f8-2c1,2c6-' +
  '2d1,2e0-2e4,2ec,2ee,370-374,376-377,37a-37d,37f,386,388-38a,38c,38e-' +
  '3a1,3a3-3f5,3f7-481,48a-52f,531-556,558-559,560-588,58b-58c,5d0-' +
  '5ea,5ef-5f2,620-64a,660-669,66e-66f,671-6d3,6d5,6e5-6e6,6ee-' +
  '6fc,6ff,710,712-72f,74d-7a5,7b1,7c0-7ea,7f4-7f5,7fa,800-' +
  '815,81a,824,828,840-858,860-86a,870-887,889-88f,8a0-8c9,904-' +
  '939,93d,950,958-961,966-96f,971-980,985-98c,98f-990,993-9a8,9aa-' +
  '9b0,9b2,9b6-9b9,9bd,9ce,9dc-9dd,9df-9e1,9e6-9f1,9f4-9f9,9fc,a05-' +
  'a0a,a0f-a10,a13-a28,a2a-a30,a32-a33,a35-a36,a38-a39,a59-a5c,a5e,a66-' +
  'a6f,a72-a74,a85-a8d,a8f-a91,a93-aa8,aaa-ab0,ab2-ab3,ab5-' +
  'ab9,abd,ad0,ae0-ae1,ae6-aef,af9,b05-b0c,b0f-b10,b13-b28,b2a-b30,b32-' +
  'b33,b35-b39,b3d,b5c-b5d,b5f-b61,b66-b6f,b71-b77,b83,b85-b8a,b8e-' +
  'b90,b92-b95,b99-b9a,b9c,b9e-b9f,ba3-ba4,ba8-baa,bae-bb9,bd0,be6-' +
  'bf2,c05-c0c,c0e-c10,c12-c28,c2a-c39,c3d,c58-c5a,c5c-c5d,c60-c61,c66-' +
  'c6f,c78-c7e,c80,c85-c8c,c8e-c90,c92-ca8,caa-cb3,cb5-cb9,cbd,cdc-cde,ce' +
  '0-ce1,ce6-cef,cf1-cf2,d04-d0c,d0e-d10,d12-d3a,d3d,d4e,d54-d56,d58-' +
  'd61,d66-d78,d7a-d7f,d85-d96,d9a-db1,db3-dbb,dbd,dc0-dc6,de6-def,e01-' +
  'e30,e32-e33,e40-e46,e50-e59,e81-e82,e84,e86-e8a,e8c-ea3,ea5,ea7-' +
  'eb0,eb2-eb3,ebd,ec0-ec4,ec6,ed0-ed9,edc-edf,f00,f20-f33,f40-f47,f49-' +
  'f6c,f88-f8c,1000-102a,103f-1049,1050-1055,105a-105d,1061,1065-' +
  '1066,106e-1070,1075-1081,108e,1090-1099,10a0-10c5,10c7,10cd,10d0-' +
  '10fa,10fc-1248,124a-124d,1250-1256,1258,125a-125d,1260-1288,128a-' +
  '128d,1290-12b0,12b2-12b5,12b8-12be,12c0,12c2-12c5,12c8-12d6,12d8-' +
  '1310,1312-1315,1318-135a,1369-137c,1380-138f,13a0-13f5,13f8-13fd,1401-' +
  '166c,166f-167f,1681-169a,16a0-16ea,16ee-16f8,1700-1711,171f-1731,1740-' +
  '1751,1760-176c,176e-1770,1780-17b3,17d7,17dc,17e0-17e9,17f0-17f9,1810-' +
  '1819,1820-1878,1880-1884,1887-18a8,18aa,18b0-18f5,1900-191e,1946-' +
  '196d,1970-1974,1980-19ab,19b0-19c9,19d0-19da,1a00-1a16,1a20-1a54,1a80-' +
  '1a89,1a90-1a99,1aa7,1b05-1b33,1b45-1b4c,1b50-1b59,1b83-1ba0,1bae-' +
  '1be5,1c00-1c23,1c40-1c49,1c4d-1c7d,1c80-1c8a,1c90-1cba,1cbd-1cbf,1ce9-' +
  '1cec,1cee-1cf3,1cf5-1cf6,1cfa,1d00-1dbf,1e00-1f15,1f18-1f1d,1f20-' +
  '1f45,1f48-1f4d,1f50-1f57,1f59,1f5b,1f5d,1f5f-1f7d,1f80-1fb4,1fb6-' +
  '1fbc,1fbe,1fc2-1fc4,1fc6-1fcc,1fd0-1fd3,1fd6-1fdb,1fe0-1fec,1ff2-' +
  '1ff4,1ff6-1ffc,2070-2071,2074-2079,207f-2089,208f-209f,2102,2107,210a-' +
  '2113,2115,2119-211d,2124,2126,2128,212a-212d,212f-2139,213c-213f,2145-' +
  '2149,214e,2150-2189,2460-249b,24ea-24ff,2776-2793,2c00-2ce4,2ceb-' +
  '2cee,2cf2-2cf3,2cfd,2d00-2d25,2d27,2d2d,2d30-2d67,2d6f,2d80-2d96,2da0-' +
  '2da6,2da8-2dae,2db0-2db6,2db8-2dbe,2dc0-2dc6,2dc8-2dce,2dd0-2dd6,2dd8-' +
  '2dde,2e2f,3005-3007,3021-3029,3031-3035,3038-303c,3041-3096,309d-' +
  '309f,30a1-30fa,30fc-30ff,3105-312f,3131-318e,3192-3195,31a0-31bf,31f0-' +
  '31ff,3220-3229,3248-324f,3251-325f,3280-3289,32b1-32bf,3400-4dbf,4e00-' +
  'a48c,a4d0-a4fd,a500-a60c,a610-a62b,a640-a66e,a67f-a69d,a6a0-a6ef,a717-' +
  'a71f,a722-a788,a78b-a7dd,a7e2,a7f1-a801,a803-a805,a807-a80a,a80c-' +
  'a822,a830-a835,a840-a873,a882-a8b3,a8d0-a8d9,a8f2-a8f7,a8fb,a8fd-' +
  'a8fe,a900-a925,a930-a946,a960-a97c,a984-a9b2,a9cf-a9d9,a9e0-a9e4,a9e6-' +
  'a9fe,aa00-aa28,aa40-aa42,aa44-aa4b,aa50-aa59,aa60-aa76,aa7a,aa7e-' +
  'aaaf,aab1,aab5-aab6,aab9-aabd,aac0,aac2,aadb-aadd,aae0-aaea,aaf2-' +
  'aaf4,ab01-ab06,ab09-ab0e,ab11-ab16,ab20-ab26,ab28-ab2e,ab30-ab5a,ab5c-' +
  'ab69,ab6c-ab6d,ab70-abe2,abf0-abf9,ac00-d7a3,d7b0-d7c6,d7cb-d7fb,f900-' +
  'fa6d,fa70-fad9,fb00-fb06,fb13-fb17,fb1d,fb1f-fb28,fb2a-fb36,fb38-' +
  'fb3c,fb3e,fb40-fb41,fb43-fb44,fb46-fbb1,fbd3-fd3d,fd50-fd8f,fd92-' +
  'fdc7,fdf0-fdfb,fe70-fe74,fe76-fefc,ff10-ff19,ff21-ff3a,ff41-ff5a,ff66-' +
  'ffbe,ffc2-ffc7,ffca-ffcf,ffd2-ffd7,ffda-ffdc,10000-1000b,1000d-' +
  '10026,10028-1003a,1003c-1003d,1003f-1004d,10050-1005d,10080-' +
  '100fa,10107-10133,10140-10178,1018a-1018b,10280-1029c,102a0-' +
  '102d0,102e1-102fb,10300-10323,1032d-1034a,10350-10375,10380-' +
  '1039d,103a0-103c3,103c8-103cf,103d1-103d5,10400-1049d,104a0-' +
  '104a9,104b0-104d3,104d8-104fb,10500-10527,10530-10563,10570-' +
  '1057a,1057c-1058a,1058c-10592,10594-10595,10597-105a1,105a3-' +
  '105b1,105b3-105b9,105bb-105bc,105c0-105f3,10600-10736,10740-' +
  '10755,10760-10767,10780-10785,10787-107b0,107b2-107bf,10800-' +
  '10805,10808,1080a-10835,10837-10838,1083c,1083f-10855,10858-' +
  '10876,10879-1089e,108a7-108af,108e0-108f2,108f4-108f5,108fb-' +
  '1091b,10920-10939,10940-10959,10980-109b7,109bc-109cf,109d2-' +
  '10a00,10a10-10a13,10a15-10a17,10a19-10a35,10a40-10a48,10a60-' +
  '10a7e,10a80-10a9f,10ac0-10ac7,10ac9-10ae4,10aeb-10aef,10b00-' +
  '10b35,10b40-10b55,10b58-10b72,10b78-10b91,10ba9-10baf,10c00-' +
  '10c48,10c80-10cb2,10cc0-10cf2,10cfa-10d23,10d30-10d39,10d40-' +
  '10d65,10d6f-10d85,10e60-10e7e,10e80-10ea9,10eb0-10eb1,10ec2-' +
  '10ec7,10ed9-10eee,10f00-10f27,10f30-10f45,10f51-10f54,10f70-' +
  '10f81,10fb0-10fcb,10fe0-10ff6,11003-11037,11052-1106f,11071-' +
  '11072,11075,11083-110af,110d0-110e8,110f0-110f9,11103-11126,11136-' +
  '1113f,11144,11147,11150-11172,11176,11183-111b2,111c1-111c4,111d0-' +
  '111da,111dc,111e1-111f4,11200-11211,11213-1122b,1123f-11240,11280-' +
  '11286,11288,1128a-1128d,1128f-1129d,1129f-112a8,112b0-112de,112f0-' +
  '112f9,11305-1130c,1130f-11310,11313-11328,1132a-11330,11332-' +
  '11333,11335-11339,1133d,11350,1135d-11361,11380-' +
  '11389,1138b,1138e,11390-113b5,113b7,113d1,113d3,11400-11434,11447-' +
  '1144a,11450-11459,1145f-11461,11480-114af,114c4-114c5,114c7,114d0-' +
  '114d9,11580-115ae,115d8-115db,11600-1162f,11644,11650-11659,11680-' +
  '116aa,116b8,116c0-116c9,116d0-116e3,11700-1171a,11730-1173b,11740-' +
  '11746,11800-1182b,118a0-118f2,118ff-11906,11909,1190c-11913,11915-' +
  '11916,11918-1192f,1193f,11941,11950-11959,119a0-119a7,119aa-' +
  '119d0,119e1,119e3,11a00,11a0b-11a32,11a3a,11a50,11a5c-' +
  '11a89,11a9d,11ab0-11af8,11b0a,11bc0-11be0,11bf0-11bf9,11c00-' +
  '11c08,11c0a-11c2e,11c40,11c50-11c6c,11c72-11c8f,11d00-11d06,11d08-' +
  '11d09,11d0b-11d30,11d46,11d50-11d59,11d60-11d65,11d67-11d68,11d6a-' +
  '11d89,11d98,11da0-11da9,11db0-11ddb,11de0-11de9,11df1,11ee0-' +
  '11ef2,11f02,11f04-11f10,11f12-11f33,11f50-11f59,11fb0,11fc0-' +
  '11fd4,12000-12399,12400-1246f,12475-12543,12550-12686,12f90-' +
  '12ff0,13000-1342f,13441-13446,13460-143fa,14400-14646,16100-' +
  '1611d,16130-16139,16800-16a38,16a40-16a5e,16a60-16a69,16a70-' +
  '16abe,16ac0-16ac9,16ad0-16aed,16b00-16b2f,16b40-16b43,16b50-' +
  '16b59,16b5b-16b61,16b63-16b77,16b7d-16b8f,16d40-16d6c,16d70-' +
  '16d79,16e40-16e96,16ea0-16eb8,16ebb-16ed3,16f00-16f4a,16f50,16f93-' +
  '16f9f,16fe0-16fe1,16fe3,16ff2-16ff6,17000-18cda,18cff-18d20,18d80-' +
  '18df2,18e00-19191,191a0-191d2,1aff0-1aff3,1aff5-1affb,1affd-' +
  '1affe,1b000-1b128,1b132,1b150-1b152,1b155,1b164-1b168,1b170-' +
  '1b2fb,1bc00-1bc6a,1bc70-1bc7c,1bc80-1bc88,1bc90-1bc99,1ccf0-' +
  '1ccf9,1d2c0-1d2d3,1d2e0-1d2f3,1d360-1d378,1d400-1d454,1d456-' +
  '1d49c,1d49e-1d49f,1d4a2,1d4a5-1d4a6,1d4a9-1d4ac,1d4ae-' +
  '1d4b9,1d4bb,1d4bd-1d4c3,1d4c5-1d505,1d507-1d50a,1d50d-1d514,1d516-' +
  '1d51c,1d51e-1d539,1d53b-1d53e,1d540-1d544,1d546,1d54a-1d550,1d552-' +
  '1d6a6,1d6a8-1d6c0,1d6c2-1d6da,1d6dc-1d6fa,1d6fc-1d714,1d716-' +
  '1d734,1d736-1d74e,1d750-1d76e,1d770-1d788,1d78a-1d7a8,1d7aa-' +
  '1d7c2,1d7c4-1d7cb,1d7ce-1d7ff,1df00-1df81,1df90-1df96,1dfcd-' +
  '1dfff,1e030-1e06d,1e100-1e12c,1e137-1e13d,1e140-1e149,1e14e,1e290-' +
  '1e2ad,1e2c0-1e2eb,1e2f0-1e2f9,1e4d0-1e4eb,1e4f0-1e4f9,1e5d0-' +
  '1e5ed,1e5f0-1e5fa,1e6c0-1e6de,1e6e0-1e6e2,1e6e4-1e6e5,1e6e7-' +
  '1e6ed,1e6f0-1e6f4,1e6fe-1e6ff,1e7e0-1e7e6,1e7e8-1e7eb,1e7ed-' +
  '1e7ee,1e7f0-1e7fe,1e800-1e8c4,1e8c7-1e8cf,1e900-1e943,1e94b,1e950-' +
  '1e959,1ec71-1ecab,1ecad-1ecaf,1ecb1-1ecb4,1ed01-1ed2d,1ed2f-' +
  '1ed3d,1ee00-1ee03,1ee05-1ee1f,1ee21-1ee22,1ee24,1ee27,1ee29-' +
  '1ee32,1ee34-1ee37,1ee39,1ee3b,1ee42,1ee47,1ee49,1ee4b,1ee4d-' +
  '1ee4f,1ee51-1ee52,1ee54,1ee57,1ee59,1ee5b,1ee5d,1ee5f,1ee61-' +
  '1ee62,1ee64,1ee67-1ee6a,1ee6c-1ee72,1ee74-1ee77,1ee79-' +
  '1ee7c,1ee7e,1ee80-1ee89,1ee8b-1ee9b,1eea1-1eea3,1eea5-1eea9,1eeab-' +
  '1eebb,1f100-1f10c,1fbf0-1fbf9,20000-2a6df,2a700-2b81e,2b820-' +
  '2cead,2ceb0-2ebe0,2ebf0-2ee5d,2f800-2fa1d,30000-3134a,31350-' +
  '33479,3d000-3fc3f';
// \p{M}
const MARK =
  '300-36f,483-489,591-5bd,5bf,5c1-5c2,5c4-5c5,5c7-5c9,610-61a,64b-' +
  '65f,670,6d6-6dc,6df-6e4,6e7-6e8,6ea-6ed,711,730-74a,7a6-7b0,7eb-' +
  '7f3,7fd,816-819,81b-823,825-827,829-82d,859-85b,897-89f,8ca-8e1,8e3-' +
  '903,93a-93c,93e-94f,951-957,962-963,981-983,9bc,9be-9c4,9c7-9c8,9cb-' +
  '9cd,9d7,9e2-9e3,9fe,a01-a03,a3c,a3e-a42,a47-a48,a4b-a4d,a51,a70-' +
  'a71,a75,a81-a83,abc,abe-ac5,ac7-ac9,acb-acd,ae2-ae3,afa-' +
  'aff,b01-b03,b3c,b3e-b44,b47-b48,b4b-b4d,b53-b57,b62-b63,b82,bbe-' +
  'bc2,bc6-bc8,bca-bcd,bd7,c00-c04,c3c,c3e-c44,c46-c48,c4a-c4d,c55-' +
  'c56,c62-c63,c81-c83,cbc,cbe-cc4,cc6-cc8,cca-ccd,cd5-cd6,ce2-' +
  'ce3,cf3,d00-d03,d3b-d3c,d3e-d44,d46-d48,d4a-d4d,d57,d62-d63,d81-' +
  'd83,dca,dcf-dd4,dd6,dd8-ddf,df2-df3,e31,e34-e3a,e47-e4e,eb1,eb4-' +
  'ebc,ec8-ece,f18-f19,f35,f37,f39,f3e-f3f,f71-f84,f86-f87,f8d-f97,f99-' +
  'fbc,fc6,102b-103e,1056-1059,105e-1060,1062-1064,1067-106d,1071-' +
  '1074,1082-108d,108f,109a-109d,135d-135f,1712-1715,1732-1734,1752-' +
  '1753,1772-1773,17b4-17d3,17dd,180b-180d,180f,1885-1886,18a9,1920-' +
  '192b,1930-193b,1a17-1a1b,1a55-1a5e,1a60-1a7c,1a7f,1ab0-1af0,1b00-' +
  '1b04,1b34-1b44,1b6b-1b73,1b80-1b82,1ba1-1bad,1be6-1bf3,1c24-1c37,1cd0-' +
  '1cd2,1cd4-1ce8,1ced,1cf4,1cf7-1cf9,1dc0-1dff,20d0-20f0,2cef-' +
  '2cf1,2d7f,2de0-2dff,302a-302f,3099-309a,a66f-a672,a674-a67d,a69e-' +
  'a69f,a6f0-a6f1,a802,a806,a80b,a823-a827,a82c,a880-a881,a8b4-a8c5,a8e0-' +
  'a8f1,a8ff,a926-a92d,a947-a953,a980-a983,a9b3-a9c0,a9e5,aa29-' +
  'aa36,aa43,aa4c-aa4d,aa7b-aa7d,aab0,aab2-aab4,aab7-aab8,aabe-' +
  'aabf,aac1,aaeb-aaef,aaf5-aaf6,abe3-abea,abec-abed,fb1e,fe00-fe0f,fe20-' +
  'fe2f,101fd,102e0,10376-1037a,10a01-10a03,10a05-10a06,10a0c-' +
  '10a0f,10a38-10a3a,10a3f,10ae5-10ae6,10d24-10d27,10d69-10d6d,10eab-' +
  '10eac,10ecb-10ecf,10ef0-10eff,10f46-10f50,10f82-10f85,11000-' +
  '11002,11038-11046,11070,11073-11074,1107f-11082,110b0-' +
  '110ba,110c2,11100-11102,11127-11134,11145-11146,11173,11180-' +
  '11182,111b3-111c0,111c9-111cc,111ce-111cf,1122c-' +
  '11237,1123e,11241,112df-112ea,11300-11303,1133b-1133c,1133e-' +
  '11344,11347-11348,1134b-1134d,11357,11362-11363,11366-1136c,11370-' +
  '11374,113b8-113c0,113c2,113c5,113c7-113ca,113cc-113d0,113d2,113e1-' +
  '113e2,11435-11446,1145e,114b0-114c3,115af-115b5,115b8-115c0,115dc-' +
  '115dd,11630-11640,116ab-116b7,1171d-1172b,1182c-1183a,11930-' +
  '11935,11937-11938,1193b-1193e,11940,11942-11943,119d1-119d7,119da-' +
  '119e0,119e4,11a01-11a0a,11a33-11a39,11a3b-11a3e,11a47,11a51-' +
  '11a5b,11a8a-11a99,11b60-11b67,11c2f-11c36,11c38-11c3f,11c92-' +
  '11ca7,11ca9-11cb6,11d31-11d36,11d3a,11d3c-11d3d,11d3f-' +
  '11d45,11d47,11d8a-11d8e,11d90-11d91,11d93-11d97,11df0,11ef3-' +
  '11ef6,11f00-11f01,11f03,11f34-11f3a,11f3e-11f42,11f5a,13440,13447-' +
  '13455,1611e-1612f,16af0-16af4,16b30-16b36,16f4f,16f51-16f87,16f8f-' +
  '16f92,16fe4,16ff0-16ff1,1bc9d-1bc9e,1cf00-1cf2d,1cf30-1cf46,1d127-' +
  '1d128,1d165-1d169,1d16d-1d172,1d17b-1d182,1d185-1d18b,1d1aa-' +
  '1d1ad,1d242-1d244,1d250-1d252,1d25b-1d25c,1d25f,1d280-1d281,1da00-' +
  '1da36,1da3b-1da6c,1da75,1da84,1da9b-1da9f,1daa1-1daaf,1e000-' +
  '1e006,1e008-1e018,1e01b-1e021,1e023-1e024,1e026-1e02a,1e08f,1e130-' +
  '1e136,1e2ae,1e2ec-1e2ef,1e4ec-1e4ef,1e5ee-1e5ef,1e6e3,1e6e6,1e6ee-' +
  '1e6ef,1e6f5,1e8d0-1e8d6,1e944-1e94a,e0100-e01ef';

/** A Postgres bracket expression for a range list. */
function bracket(ranges: string): string {
  const cp = (hex: string): string => String.fromCodePoint(parseInt(hex, 16));
  const body = ranges
    .split(',')
    .map((r) => r.split('-').map(cp).join('-'))
    .join('');
  return `[${body}]`;
}

/**
 * Display names, mirroring the API (DisplayName): no default ignorables or
 * other invisible characters, a letter or digit, no leading combining mark,
 * nothing address-like, no reserved UI label.
 */
export class DisplayNameRules1794873600000 implements MigrationInterface {
  name = 'DisplayNameRules1794873600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rules = `display_name !~ $$${bracket(INVISIBLE)}$$
        AND display_name ~ $$${bracket(LETTER_OR_DIGIT)}$$
        AND display_name !~ $$^${bracket(MARK)}$$
        AND display_name !~* '^0x[0-9a-f]'
        AND lower(regexp_replace(display_name, '\\s+', ' ', 'g'))
          NOT IN ('deleted user', 'you', 'a member')`;
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    // names valid under 0007/0008 but not under these rules are cleared
    // (the user sets a new one) rather than failing the migration
    await queryRunner.query(
      `UPDATE users SET display_name = NULL, updated_at = now()
       WHERE display_name IS NOT NULL AND NOT (${rules})`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD CONSTRAINT users_display_name_rules_check CHECK (${rules})`,
    );
    await queryRunner.query(`SET LOCAL lock_timeout = DEFAULT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP CONSTRAINT users_display_name_rules_check`,
    );
  }
}
