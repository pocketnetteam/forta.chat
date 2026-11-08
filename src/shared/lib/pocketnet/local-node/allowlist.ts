/** Deliberate copy of proxy16/node/rpc.js publics/posts/privates. */

const PRIVATES: ReadonlySet<string> = new Set([
  "stop",
  "listaddressgroupings",
  "listaddresses",
  "importprivkey",
  "getbalance",
  "getstakinginfo",
  "getnewaddress",
  "dumpwallet",
  "importwallet",
  "sendtoaddress",
]);

const POSTS: ReadonlySet<string> = new Set([
  "sendrawtransaction",
  "sendrawtransactionwithmessage",
]);

const PUBLICS: ReadonlySet<string> = new Set([
  "getcontent",
  "getcontents",
  "getlastcomments",
  "gettags",
  "getrawtransactionwithmessagebyid",
  "getrawtransactionwithmessage",
  "getrawtransaction",
  "getuserprofile",
  "getuserstate",
  "getaccountsetting",
  "getaddressregistration",
  "getusersubscribes",
  "getusersubscribers",
  "getuserblockings",
  "signrawtransactionwithkey",
  "getrecommendedposts",
  "gettime",
  "getmissedinfo",
  "gethotposts",
  "getmostcommentedfeed",
  "getuseraddress",
  "search",
  "searchlinks",
  "searchusers",
  "getcomments",
  "sendcomment",
  "getnodeinfo",
  "getaddressscores",
  "getnotifications",
  "getpostscores",
  "getpagescores",
  "getactivities",
  "getrandomcontents",
  "getrecomendedaccountsbysubscriptions",
  "getrecomendedaccountsbyscoresonsimilaraccounts",
  "getrecomendedaccountsbyscoresfromaddress",
  "getrecomendedcontentsbyscoresfromaddress",
  "getrecomendedaccountsbytags",
  "getboostfeed",
  "getboostsbyaddress",
  "getprofilefeed",
  "getsubscribesfeed",
  "getblocktransactions",
  "getaddressinfo",
  "getaddresstransactions",
  "gettransactions",
  "getblock",
  "getblocks",
  "getlastblocks",
  "getcompactblock",
  "checkstringtype",
  "getstatistic",
  "getinfo",
  "getcoininfo",
  "getpeerinfo",
  "getPeerInfo",
  "txunspent",
  "estimatefee",
  "estimatesmartfee",
  "gettransaction",
  "gethierarchicalstrip",
  "getprofilecollections",
  "gethistoricalstrip",
  "getusercontents",
  "getcontentstatistic",
  "getuserstatistic",
  "searchbyhash",
  "getstatisticbyhours",
  "getstatisticbydays",
  "getstatisticcontentbyhours",
  "getstatisticcontentbydays",
  "gettopfeed",
  "getrecommendedcontentbyaddress",
  "gettopaccounts",
  "getrecommendedaccountbyaddress",
  "getcontented",
  "getsubscribeschannels",
  "getaccountearning",
  "getbans",
  "getfromtotransactions",
  "getapps",
  "getappscores",
  "getappcomments",
]);

export type RpcPathKind = "public" | "post" | "private" | null;

export function classifyRpcMethod(method: string): RpcPathKind {
  if (!method) return null;
  if (POSTS.has(method)) return "post";
  if (PUBLICS.has(method)) return "public";
  if (PRIVATES.has(method)) return "private";
  return null;
}

export function isRpcAllowed(
  method: string,
  opts?: { rpcuser?: string; rpcpass?: string },
): boolean {
  const kind = classifyRpcMethod(method);
  if (kind === "public" || kind === "post") return true;
  if (kind === "private") return Boolean(opts?.rpcuser && opts?.rpcpass);
  return false;
}

export function pathForRpcMethod(
  method: string,
  opts?: { rpcuser?: string; rpcpass?: string },
): "/public/" | "/post/" | null {
  const kind = classifyRpcMethod(method);
  if (kind === "post") return "/post/";
  if (kind === "public") return "/public/";
  if (kind === "private" && opts?.rpcuser && opts?.rpcpass) return null;
  return null;
}
