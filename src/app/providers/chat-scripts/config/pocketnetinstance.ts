export const PocketnetInstance: PocketnetInstanceType = {
  apiHandlers: {
    error: () => null,
    success: () => null
  },
  menuOpen: () => {
    // Will be wired to drawer/sidebar toggle
  },
  mobile: {
    supportimagegallery: () => null
  },
  options: {
    address: "https://bastyon.com",
    backmap: undefined,
    device: "241dcb2c-6345-e8a8-8648-b12da53ba7cb",
    fingerPrint: "66616b6566696e6765727072696e74",
    firebase: "https://bastyon.com:8888",
    fullName: "bastyon",
    imageServer: "https://api.imgur.com/3/",
    imageServerup1: "https://pocketnet.app:8092/up",
    imageStorage: "https://api.imgur.com/3/images/",
    listofnodes: null,
    listofproxies: [
      { host: "1.pocketnet.app", port: 8899, wss: 8099 },
      { host: "2.pocketnet.app", port: 8899, wss: 8099 },
      { host: "3.pocketnet.app", port: 8899, wss: 8099 },
      { host: "6.pocketnet.app", port: 8899, wss: 8099 }
    ],
    localStoragePrefix: "bastyon",
    matrix: "matrix.pocketnet.app",
    name: "PCRB",
    nav: {
      navPrefix: "/"
    },
    rtc: "https://bastyon.com:9001/",
    rtchttp: "https://pocketnet.app:9091",
    rtcws: "wss://pocketnet.app:9090",
    server: "https://pocketnet.app/Shop/AJAXMain.aspx",
    url: "bastyon.com"
  },
  platform: {
    matrixchat: {
      link: () => null
    },
    sdk: {
      syncStorage: {
        eventListeners: {},
        _storageHandler: null as ((e: StorageEvent) => void) | null,
        init() {
          window.storage_tab = Date.now();
          // Remove previous listener if init() is called again (idempotent)
          if (this._storageHandler) {
            window.removeEventListener("storage", this._storageHandler);
          }
          this._storageHandler = (e: StorageEvent) => {
            if (!e.key) return;

            if (!e.oldValue) {
              this.eventListeners[e.key]?.create?.(e);
              return;
            }
            if (!e.newValue) {
              this.eventListeners[e.key]?.delete?.(e);
              return;
            }
            this.eventListeners[e.key]?.change?.(e);
          };
          window.addEventListener("storage", this._storageHandler);
        },
        off(eventType: string, lStorageProp: string) {
          if (this.eventListeners[lStorageProp]) {
            delete this.eventListeners[lStorageProp][eventType];
            if (Object.keys(this.eventListeners[lStorageProp]).length === 0) {
              delete this.eventListeners[lStorageProp];
            }
          }
        },
        on(eventType: string, lStorageProp: string, callback: (e: StorageEvent) => void) {
          if (typeof this.eventListeners[lStorageProp] !== "object") {
            this.eventListeners[lStorageProp] = {};
          }
          this.eventListeners[lStorageProp][eventType] = callback;
        }
      }
    },
    timeDifference: 0,
    whiteList: [
      "PEj7QNjKdDPqE9kMDRboKoCtp8V6vZeZPd",
      "PJ3nv2jGyW2onqZVDKJf9TmfuLGpmkSK2X",
      "TAqR1ncH95eq9XKSDRR18DtpXqktxh74UU",
      "TFkhfcxXSWX5SsLcjhdiSDHEepWUcb7yi3"
    ]
  },
  user: {
    address: {
      value: null
    },
    keys: null
  }
};
