import { describe, expect, it } from "vitest";
import { sourceMutation } from "./sql-mutation.js";
import { MissionGoDatabase } from "./database.js";

describe("display writer transaction boundary",()=>{
  it("recognizes commented writes and RETURNING without locking read-only CTEs",()=>{
    expect(sourceMutation("-- source write\nUPDATE work_items SET title='SELECT'")).toBe(true);
    expect(sourceMutation("WITH selected AS (SELECT 1) SELECT * FROM selected")).toBe(false);
    expect(sourceMutation("WITH selected AS (SELECT 1) INSERT INTO example SELECT * FROM selected RETURNING id")).toBe(true);
    expect(sourceMutation("SELECT 'UPDATE example', \"DELETE\"")).toBe(false);
    const db=new MissionGoDatabase(":memory:");
    try{
      db.connection.exec("CREATE TABLE example(id INTEGER PRIMARY KEY)");
      let calls=0,fail=false;
      db.registerProjectionWriter("test",()=>{calls++;if(fail)throw new Error("Failed projection");});calls=0;
      expect(db.connection.prepare("/* real write */ INSERT INTO example VALUES (1) RETURNING id").get()).toEqual({id:1});
      expect(calls).toBe(1);
      db.connection.prepare("WITH rows AS (SELECT 1) SELECT * FROM rows").all();expect(calls).toBe(1);
      fail=true;
      expect(()=>db.connection.prepare("INSERT INTO example VALUES(2) RETURNING id").get()).toThrow("Failed projection");
      expect(db.connection.prepare("SELECT * FROM example").all()).toEqual([{id:1}]);
    }finally{db.close();}
  });
});
