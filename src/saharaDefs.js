export const cmd_t = {
  SAHARA_HELLO_REQ: 0x1,
  SAHARA_HELLO_RSP: 0x2,
  SAHARA_READ_DATA: 0x3,
  SAHARA_END_TRANSFER: 0x4,
  SAHARA_DONE_REQ: 0x5,
  SAHARA_DONE_RSP: 0x6,
  SAHARA_RESET_RSP: 0x8,
  SAHARA_CMD_READY: 0xB,
  SAHARA_SWITCH_MODE: 0xC,
  SAHARA_EXECUTE_REQ: 0xD,
  SAHARA_EXECUTE_RSP: 0xE,
  SAHARA_EXECUTE_DATA: 0xF,
  SAHARA_64BIT_MEMORY_READ_DATA: 0x12,
};

export const exec_cmd_t = {
  SAHARA_EXEC_CMD_SERIAL_NUM_READ: 0x01,
};

export const sahara_mode_t = {
  SAHARA_MODE_IMAGE_TX_PENDING: 0x0,
  SAHARA_MODE_COMMAND: 0x3,
};

export const status_t = {
  SAHARA_STATUS_SUCCESS: 0x00,  // Invalid command received in current state
  SAHARA_NAK_INVALID_CMD: 0x01,  // Protocol mismatch between host and targe
};
